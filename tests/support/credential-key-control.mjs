import {transitionCredentialKeyControl} from '../../api/_credential-key-control.js';

export async function adoptCredentialKeyControl(db,ring){
  return transitionCredentialKeyControl(db,{operation:'adopt',ring});
}

export async function adoptCredentialKeyControls(db,rings){
  for(const ring of rings) await adoptCredentialKeyControl(db,ring);
}

export async function advanceCredentialKeyControl(db,ring,{expectedVersion,expectedGeneration}={}){
  return transitionCredentialKeyControl(db,{
    operation:'advance',ring,expectedVersion,expectedGeneration,
  });
}
