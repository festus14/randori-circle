// Minimal DOM for exercising the shipped consent controller with the real API.
class Node {
  constructor(doc,tag){ this.doc=doc; this.tagName=tag; this.children=[]; this.hidden=true; this.isConnected=true; this._text=''; }
  set textContent(value){ this._text=value; this.children=[]; }
  get textContent(){ return this._text+this.children.map(child=>child.textContent).join(''); }
  append(...children){ this.children.push(...children); }
  replaceChildren(...children){ this.children=children; }
  setAttribute(){}
  addEventListener(){}
  focus(){ this.doc.activeElement=this; }
  showModal(){ this.hidden=false; }
  close(){ this.hidden=true; }
  remove(){ this.doc.body.children=this.doc.body.children.filter(child=>child!==this); this.isConnected=false; }
  all(){ return this.children.flatMap(child=>[child,...child.all()]); }
  click(){ this.onclick?.(); }
}

export function consentDocument(){
  const doc={activeElement:null};
  doc.createElement=tag=>new Node(doc,tag);
  doc.body=doc.createElement('body');
  for(const id of ['aiConsentStatus','aiPartnerConsent','aiAnalysisConfirm','aiConsentProfile']){
    const element=doc.createElement('section'); element.id=id; doc.body.append(element);
  }
  doc.getElementById=id=>doc.body.all().find(node=>node.id===id);
  doc.button=text=>doc.body.all().find(node=>node.tagName==='button'&&node.textContent===text);
  return doc;
}

export const consentWindow={addEventListener(){},setInterval(){}};
export async function until(predicate){
  for(let i=0;i<100;i++){
    if(await predicate()) return;
    await new Promise(resolve=>setImmediate(resolve));
  }
  throw new Error('consent controller did not reach the expected state');
}
