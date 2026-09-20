import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import test from 'node:test';
import {isAlias,isMap,isScalar,isSeq,parseDocument} from 'yaml';

const workflowRoot=new URL('../../.github/workflows/',import.meta.url);
const approvedActions=new Map([
  ['actions/checkout','3d3c42e5aac5ba805825da76410c181273ba90b1'], // v7.0.1, node24
  ['actions/setup-node','820762786026740c76f36085b0efc47a31fe5020'], // v7.0.0, node24
  ['actions/upload-artifact','043fb46d1a93c77aae656e7c1c64a875d1fc6a0a'], // v7.0.1, node24
  ['actions/download-artifact','3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c'], // v8.0.1, node24
]);

function workflowSources(){
  return readdirSync(workflowRoot).filter(file=>/\.ya?ml$/u.test(file)).sort()
    .map(name=>({name,source:readFileSync(new URL(name,workflowRoot),'utf8')}));
}

function workflowActionReferences(name,source){
  const document=parseDocument(source,{prettyErrors:false,uniqueKeys:true});
  assert.equal(document.errors.length,0,`${name} must contain valid YAML`);
  const references=[];

  function visit(node){
    assert.equal(isAlias(node),false,`${name} must not use YAML aliases`);
    if(isMap(node)){
      for(const pair of node.items){
        assert.ok(
          isScalar(pair.key)&&typeof pair.key.value==='string',
          `${name} must use scalar string mapping keys`,
        );
        if(pair.key.value==='uses'){
          assert.ok(
            isScalar(pair.value)&&typeof pair.value.value==='string',
            `${name} contains an invalid action reference`,
          );
          references.push(pair.value.value);
        }
        visit(pair.value);
      }
    }else if(isSeq(node)){
      for(const item of node.items) visit(item);
    }
  }

  visit(document.contents);
  return references;
}

function assertApprovedWorkflowActions(workflows){
  const seen=new Set();
  for(const {name,source} of workflows){
    const references=workflowActionReferences(name,source);
    for(const reference of references){
      const parsed=/^(actions\/(?:checkout|setup-node|upload-artifact|download-artifact))@([a-f0-9]{40})$/u
        .exec(reference);
      assert.ok(parsed,`${name} must use a reviewed immutable first-party action: ${reference}`);
      const [,action,revision]=parsed;
      assert.equal(revision,approvedActions.get(action),`${name} uses an unapproved ${action} revision`);
      seen.add(action);
    }
  }
  assert.deepEqual([...seen].sort(),[...approvedActions.keys()].sort());
}

test('every GitHub-hosted action is an approved immutable Node 24 revision',()=>{
  assertApprovedWorkflowActions(workflowSources());
});

test('valid YAML key spacing cannot hide mutable or unapproved actions',()=>{
  const mutable=workflowSources().map(item=>({...item}));
  const e2e=mutable.find(item=>item.name==='e2e.yml');
  e2e.source=e2e.source.replace(
    'uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    'uses : actions/checkout@v7',
  );
  assert.throws(()=>assertApprovedWorkflowActions(mutable),/must use a reviewed immutable first-party action/u);

  const unknown=workflowSources().map(item=>({...item}));
  const deployability=unknown.find(item=>item.name==='deployability.yml');
  deployability.source=deployability.source.replace(
    'uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
    "'uses' : actions/cache@0123456789abcdef0123456789abcdef01234567",
  );
  assert.throws(()=>assertApprovedWorkflowActions(unknown),/must use a reviewed immutable first-party action/u);

  const flowMapping=workflowSources().map(item=>({...item}));
  const flowE2e=flowMapping.find(item=>item.name==='e2e.yml');
  flowE2e.source=flowE2e.source.replace(
    '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false',
    '      - { uses: actions/checkout@v7, with: { persist-credentials: false } }',
  );
  assert.throws(
    ()=>assertApprovedWorkflowActions(flowMapping),
    /must use a reviewed immutable first-party action/u,
  );

  const escapedKey=workflowSources().map(item=>({...item}));
  const escapedE2e=escapedKey.find(item=>item.name==='e2e.yml');
  escapedE2e.source=escapedE2e.source.replace(
    '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
    '      - "u\\u0073es": actions/checkout@v7',
  );
  assert.throws(
    ()=>assertApprovedWorkflowActions(escapedKey),
    /must use a reviewed immutable first-party action/u,
  );

  const explicitEscapedKey=workflowSources().map(item=>({...item}));
  const explicitE2e=explicitEscapedKey.find(item=>item.name==='e2e.yml');
  explicitE2e.source=explicitE2e.source.replace(
    '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
    '      - ? "u\\u0073es"\n        : actions/checkout@v7',
  );
  assert.throws(
    ()=>assertApprovedWorkflowActions(explicitEscapedKey),
    /must use a reviewed immutable first-party action/u,
  );
});

test('comments and block scalar text cannot create phantom action references',()=>{
  const harmlessText=workflowSources().map(item=>({...item}));
  const e2e=harmlessText.find(item=>item.name==='e2e.yml');
  e2e.source+='\n# uses: attacker/action@main\nx-action-example: |\n  uses: attacker/action@main\n';
  assert.doesNotThrow(()=>assertApprovedWorkflowActions(harmlessText));
});
