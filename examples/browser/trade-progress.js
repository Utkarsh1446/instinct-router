const APPROVALS = new Set(['relay-usdc-approve','relay-token-approve','relay-provider-approve']);
const sameAsset = (a,b) => a?.chainId === b?.chainId && typeof a?.address === 'string' && typeof b?.address === 'string' &&
  (a.chainId.startsWith('eip155:') ? a.address.toLowerCase() === b.address.toLowerCase() : a.address === b.address);
function units(raw,decimals) {
  if(typeof raw!=='string'||!/^\d{1,334}$/.test(raw)||!Number.isInteger(decimals)||decimals<0||decimals>255)return '—';
  if(!decimals)return raw;
  const padded=raw.padStart(decimals+1,'0'),fraction=padded.slice(-decimals).replace(/0+$/,'');
  return padded.slice(0,-decimals)+(fraction?'.'+fraction:'');
}
const shortAddress = address => address.length>18 ? address.slice(0,6)+'…'+address.slice(-4) : address;
/** A presentation model only. Display observations never authorize another wallet action. */
export function tradeProgressModel({record,progress=null,config={}}) {
  if(!record?.plan?.source||!record.plan.destination)return null;
  const plan=record.plan,complete=record.status==='COMPLETE';
  const assetLabel=asset=>config.assets?.find(item=>sameAsset(item,asset))?.symbol ?? 'tokens';
  const chainLabel=asset=>config.chains?.find(chain=>chain.chainId===asset.chainId)?.name ?? (asset.chainId.startsWith('solana:')?'Solana':'Selected network');
  const sourceLabel=assetLabel(plan.source),destinationLabel=assetLabel(plan.destination);
  const input=units(plan.amountRaw,plan.source.decimals)+' '+sourceLabel,minimumOutput=units(plan.minimumOutRaw,plan.destination.decimals)+' '+destinationLabel;
  const actions=plan.actions ?? [],submissions=record.submissions ?? [];
  const funding=submissions.filter(row=>actions.some(action=>action.id===row.actionId)&&!APPROVALS.has(row.actionId));
  const approvalOnly=!funding.length&&submissions.some(row=>APPROVALS.has(row.actionId));
  const boundProgress=progress?.routeId===plan.routeId&&funding.some(row=>row.hash===progress.sourceTransactionHash&&row.actionId===progress.actionId);
  const matchingCredit=credit=>credit&&sameAsset(credit.asset,plan.destination)&&credit.recipient===plan.recipient&&typeof credit.amountRaw==='string'&&/^\d{1,334}$/.test(credit.amountRaw)&&BigInt(credit.amountRaw)>=BigInt(plan.minimumOutRaw);
  const progressCredit=progress?.destination;
  const received=boundProgress&&progress.stage==='DESTINATION_CONFIRMED'&&matchingCredit(progressCredit);
  const finalCredit=[record.destinationReceipt?.destinationCredit,record.receipt?.destinationCredit].find(matchingCredit);
  const actualCredit=complete?finalCredit:received?progressCredit:null;
  const currentApproval=APPROVALS.has(actions[record.nextAction]?.id);
  const crossChain=plan.source.chainId!==plan.destination.chainId;
  let title=record.status==='READY'?(approvalOnly?'Ready to swap':'Review swap'):record.status==='CLAIMED'?(currentApproval?'Approve '+sourceLabel:'Confirm in wallet'):approvalOnly?'Approving '+sourceLabel:funding.length?'Swap in progress':'Waiting for wallet';
  let icon='pending';
  if(complete){title='Swap complete';icon='complete';}
  else if(record.status==='FAILED'){title='Swap failed';icon='failed';}
  else if(record.status==='EXPIRED'){title='Quote expired';icon='expired';}
  else if(record.status==='CANCELLED'){title='Swap cancelled';icon='cancelled';}
  else if(record.status==='RECOVERY_REQUIRED'){title='Checking swap status';icon='pending';}
  else if(received){title='Funds received';icon='received';}
  else if(record.status==='READY')icon='review';
  const ended=['EXPIRED','CANCELLED','FAILED'].includes(record.status);
  const steps=ended?[]:[
    {label:'Swap initiated',state:complete||funding.length?'complete':record.status==='CLAIMED'&&!currentApproval&&!approvalOnly?'active':'pending'},
    {label:crossChain?'Bridging & swapping':'Swapping',state:complete||received?'complete':funding.length?'active':'pending'},
    {label:complete?'Swap complete':'Finalizing',state:complete?'complete':received?'active':'pending'},
  ];
  const recipient=typeof plan.recipient==='string'?plan.recipient:'';
  return {title,icon,summary:input+' → '+(actualCredit?units(actualCredit.amountRaw,plan.destination.decimals)+' '+destinationLabel:'≥ '+minimumOutput),steps,
    review:record.status==='READY'?{input,minimumOutput,recipient,recipientShort:shortAddress(recipient),sourceChain:chainLabel(plan.source),destinationChain:chainLabel(plan.destination)}:null};
}
export function renderTradeProgress({document,container,record,progress=null,config={}}) {
  const model=tradeProgressModel({record,progress,config});container.replaceChildren();if(!model)return null;
  const element=(tag,className,text)=>{const node=document.createElement(tag);node.className=className;if(text!==undefined)node.textContent=text;return node;};
  const card=element('section','trade-progress');card.setAttribute('aria-label',model.title);
  const heading=element('div','trade-progress-heading'),icon=element('span','trade-progress-icon trade-progress-icon-'+model.icon,{complete:'✓',received:'↓',review:'↔',failed:'!',cancelled:'×',expired:'◷',pending:'↗'}[model.icon]);icon.setAttribute('aria-hidden','true');
  const text=element('div','trade-progress-heading-text');text.append(element('h3','trade-progress-title',model.title));
  if(!model.review)text.append(element('p','trade-progress-summary',model.summary));heading.append(icon,text);card.append(heading);
  if(model.review) {
    const details=element('dl','trade-progress-review');
    for(const [label,value,title] of [['Pay',model.review.input+' · '+model.review.sourceChain],['Minimum received',model.review.minimumOutput+' · '+model.review.destinationChain],['Receive at',model.review.recipientShort,model.review.recipient]]) {
      const row=element('div','trade-progress-review-row'),term=element('dt','',label),description=element('dd','',value);
      if(title){description.title=title;description.setAttribute('aria-label',title);}row.append(term,description);details.append(row);
    }
    card.append(details);
  }
  if(model.steps.length) {
    const list=element('ol','trade-progress-steps');list.setAttribute('aria-label','Swap progress');
    for(const step of model.steps) {
      const item=element('li','trade-progress-step trade-progress-step-'+step.state),marker=element('span','trade-progress-step-icon',step.state==='complete'?'✓':step.state==='active'?'•':'');marker.setAttribute('aria-hidden','true');
      item.setAttribute('aria-label',step.label+', '+(step.state==='complete'?'confirmed':step.state==='active'?'in progress':'pending'));
      if(step.state==='active')item.setAttribute('aria-current','step');item.append(marker,element('span','trade-progress-step-label',step.label));list.append(item);
    }
    card.append(list);
  }
  container.append(card);return model;
}
