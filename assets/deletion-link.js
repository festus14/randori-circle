// Tokens stay in memory and are removed from browser history before any request.
(()=>{
  const byId=id=>document.getElementById(id);
  const request=byId('requestForm'),confirm=byId('confirmForm'),cancel=byId('cancelForm');
  const status=byId('status'),word=byId('confirm'),button=byId('confirmButton');
  let token='',mode='request',busy=false;
  function readLink(){
    const fragment=new URLSearchParams(location.hash.slice(1));
    history.replaceState({},document.title,location.pathname);
    if(busy) return;
    token=fragment.get('cancel')||fragment.get('token')||'';
    mode=fragment.has('cancel')?'cancel':fragment.has('token')?'confirm':'request';
    request.hidden=mode!=='request';confirm.hidden=mode!=='confirm';cancel.hidden=mode!=='cancel';
    byId('intro').textContent=mode==='cancel'?'Use your emailed link to stop the scheduled deletion.'
      :mode==='confirm'?'Confirm deletion of your account.'
        :'If you left every circle or were removed, request a deletion link at your account’s email address. No password or sign-in is needed.';
    word.value='';button.disabled=true;status.textContent='';
    if(mode==='confirm') word.focus();
    if(mode==='cancel') cancel.querySelector('button').focus();
  }
  readLink();window.addEventListener('hashchange',readLink);
  word.addEventListener('input',()=>{button.disabled=busy||word.value!=='DELETE';});
  async function submit(event){
    event.preventDefault();if(busy)return;
    const form=event.currentTarget;
    if(mode==='confirm'&&word.value!=='DELETE')return;
    const operation=mode;
    const path=operation==='request'?'link':operation==='cancel'?'cancel-token':'confirm-token';
    const body=operation==='request'?{email:byId('email').value}:operation==='cancel'?{token}:{token,confirm:word.value};
    busy=true;form.querySelector('button').disabled=true;status.textContent='Working…';
    try{
      const response=await fetch(`/api/auth/account/delete/${path}`,{method:'POST',credentials:'omit',cache:'no-store',
        headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      const result=await response.json();
      if(!response.ok){
        status.textContent=response.status===409?'This link cannot be used. Request a new deletion link or use the latest cancellation email.'
          :response.status===429?'Too many attempts. Try again later.'
            :'Account deletion is unavailable. Try again later or contact Randori Circle.';
      }else{
        status.textContent=operation==='request'?result.message:operation==='cancel'
          ?'Deletion cancelled. Your account is alive, but circle membership is not restored. If you left or were removed, you stay removed and need a new invitation to sign in.'
          :`Your account is locked and scheduled for deletion on ${new Date(result.scheduled_for).toLocaleDateString('en-GB',{timeZone:'UTC'})}. Check your email for a cancellation link. Cancelling does not restore circle membership.`;
        if(operation!=='request'){token='';form.hidden=true;}
      }
    }catch{status.textContent='We could not confirm the result. Check your email or try again.';}
    finally{busy=false;form.querySelector('button').disabled=operation==='confirm'&&word.value!=='DELETE';status.focus();}
  }
  for(const form of [request,confirm,cancel])form.addEventListener('submit',submit);
})();
