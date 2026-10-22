import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';

import {
  attemptedMarkers,
  attemptInstant,
  difficultyLevel,
  DIFFICULTY_LEVELS,
  ensureExerciseSuggestionsReadiness,
  exerciseSuggestionsEnabled,
  ExerciseSuggestionsInputError,
  exerciseTopics,
  MAX_HIDDEN_SLUGS,
  MAX_SUGGESTIONS,
  normalizeSuggestionCatalogue,
  parseExerciseSuggestionsQuery,
  questionRefSlug,
  readExerciseSuggestions,
  memberAttemptStatements,
  memberAttemptsFromResults,
  readMemberAttempts,
  roomAttemptsFromResult,
  recentDifficultyLevel,
  resolveSuggestionAudience,
  RUNS_PER_EXERCISE,
  selectExerciseSuggestions,
  topicLabel,
  verifiedRunAttempt,
} from '../../api/_exercise-suggestions.js';

const realCatalogue=JSON.parse(await readFile(new URL('../../data/randori-catalog-v1.json',import.meta.url),'utf8'))
  .exercises.filter(exercise=>exercise.status==='active');

// A small catalogue with overlapping topics so every rule is visible.
const CATALOGUE=Object.freeze([
  {slug:'arrays-easy-a',version:1,title:'Arrays A',difficulty:'Easy',type:'array',tags:['arrays']},
  {slug:'arrays-easy-b',version:1,title:'Arrays B',difficulty:'Easy',type:'array',tags:['arrays','sorting']},
  {slug:'graphs-easy',version:1,title:'Graphs Easy',difficulty:'Easy',type:'graph',tags:['graphs']},
  {slug:'graphs-medium',version:2,title:'Graphs Medium',difficulty:'Medium',type:'graph',tags:['graphs','breadth-first-search']},
  {slug:'graphs-hard',version:1,title:'Graphs Hard',difficulty:'Hard',type:'graph',tags:['graphs']},
  {slug:'strings-medium',version:1,title:'Strings Medium',difficulty:'Medium',type:'string',tags:['strings']},
  {slug:'trees-hard',version:1,title:'Trees Hard',difficulty:'Hard',type:'tree',tags:['trees']},
]);

function history(entries){
  return new Map(Object.entries(entries));
}

function slugs(result){
  return result.suggestions.map(suggestion=>suggestion.slug);
}

afterEach(()=>{
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.CIRCLE_MEMBERSHIP_ENABLED;
});

test('the feature flag is on only for the exact string "true"',()=>{
  assert.equal(exerciseSuggestionsEnabled({}),false);
  assert.equal(exerciseSuggestionsEnabled({EXERCISE_SUGGESTIONS_ENABLED:'1'}),false);
  assert.equal(exerciseSuggestionsEnabled({EXERCISE_SUGGESTIONS_ENABLED:'TRUE'}),false);
  assert.equal(exerciseSuggestionsEnabled({EXERCISE_SUGGESTIONS_ENABLED:'true'}),true);
  const previous=process.env.EXERCISE_SUGGESTIONS_ENABLED;
  delete process.env.EXERCISE_SUGGESTIONS_ENABLED;
  try{ assert.equal(exerciseSuggestionsEnabled(),false); }
  finally{ if(previous!==undefined) process.env.EXERCISE_SUGGESTIONS_ENABLED=previous; }
});

test('the query accepts solo, a canonical room and a bounded hide list, and nothing else',()=>{
  assert.deepEqual(parseExerciseSuggestionsQuery({url:'/api/exercise-suggestions',query:{}}),{room:null,hidden:[]});
  assert.deepEqual(parseExerciseSuggestionsQuery({url:'/api/exercise-suggestions?hidden=',query:{}}),{room:null,hidden:[]});
  assert.deepEqual(parseExerciseSuggestionsQuery({
    url:'/api/data?endpoint=exercise-suggestions&room_id=week_10_pair_20&hidden=graphs-easy,arrays-easy-a',
  }),{room:{roomId:'week_10_pair_20',weekId:10,pairGroupId:20},hidden:['graphs-easy','arrays-easy-a']});
  // A repeated slug is an error, not silently merged.
  assert.throws(()=>parseExerciseSuggestionsQuery({
    url:'/api/exercise-suggestions?hidden=graphs-easy,arrays-easy-a,graphs-easy',
  }),{name:'ExerciseSuggestionsInputError',message:'hidden must not repeat an exercise'});
  assert.deepEqual(parseExerciseSuggestionsQuery({
    url:'/api/exercise-suggestions',query:{endpoint:'exercise-suggestions',room_id:'week_3_pair_4'},
  }).room,{roomId:'week_3_pair_4',weekId:3,pairGroupId:4});
  const many=Array.from({length:MAX_HIDDEN_SLUGS},(_,index)=>`exercise-${index}`).join(',');
  assert.equal(parseExerciseSuggestionsQuery({url:`/x?hidden=${many}`}).hidden.length,MAX_HIDDEN_SLUGS);

  const tooMany=Array.from({length:MAX_HIDDEN_SLUGS+1},(_,index)=>`e-${index}`).join(',');
  for(const req of [
    {url:'/api/exercise-suggestions?week_id=10'},
    {url:'/api/exercise-suggestions?room_id=week_10_pair_20&room_id=week_10_pair_21'},
    {url:'/api/exercise-suggestions',query:{hidden:['a','b']}},
    {url:'/api/exercise-suggestions',query:{endpoint:'runs'}},
    {url:'/api/exercise-suggestions?room_id=week_01_pair_20'},
    {url:'/api/exercise-suggestions?room_id=room'},
    {url:'/api/exercise-suggestions',query:{room_id:10}},
    {url:'/api/exercise-suggestions?hidden=Bad_Slug'},
    {url:'/api/exercise-suggestions?hidden=a,,b'},
    {url:`/api/exercise-suggestions?hidden=${'a'.repeat(121)}`},
    {url:'/api/exercise-suggestions',query:{hidden:7}},
    {url:`/api/exercise-suggestions?hidden=${'a,'.repeat(4000)}a`},
    {url:`/api/exercise-suggestions?hidden=${tooMany}`},
  ]){
    assert.throws(()=>parseExerciseSuggestionsQuery(req),ExerciseSuggestionsInputError,JSON.stringify(req));
  }
  // A malformed URL never throws past the parser; the query object still decides.
  assert.deepEqual(parseExerciseSuggestionsQuery({url:'http://[bad',query:{}}),{room:null,hidden:[]});
  assert.deepEqual(parseExerciseSuggestionsQuery({query:[]}),{room:null,hidden:[]});
  assert.throws(()=>parseExerciseSuggestionsQuery({url:'/x?hidden=b',query:{hidden:'a'}}),ExerciseSuggestionsInputError);
  assert.throws(()=>parseExerciseSuggestionsQuery({url:'/x?hidden=a&hidden=b&hidden=c',query:{hidden:'a'}}),ExerciseSuggestionsInputError);
  assert.deepEqual(parseExerciseSuggestionsQuery({url:'/x?hidden=a',query:{hidden:'a'}}).hidden,['a']);
  assert.throws(()=>parseExerciseSuggestionsQuery({url:'/x?hidden=a',query:{hidden:['a','b']}}),ExerciseSuggestionsInputError);
});

test('stored timestamps normalise to epoch milliseconds and bad values sort oldest',()=>{
  assert.equal(attemptInstant('2026-09-20 10:00:00'),Date.parse('2026-09-20T10:00:00Z'));
  assert.equal(attemptInstant('2026-09-20T10:00:00.000Z'),Date.parse('2026-09-20T10:00:00.000Z'));
  assert.equal(attemptInstant('not a date'),0);
  assert.equal(attemptInstant(null),0);
  assert.equal(questionRefSlug('graphs-easy'),'graphs-easy');
  assert.equal(questionRefSlug('graphs-easy@2'),'graphs-easy');
  assert.equal(questionRefSlug('graphs-easy@0'),null);
  assert.equal(questionRefSlug('Bad'),null);
  assert.equal(questionRefSlug(`${'a'.repeat(121)}@1`),null);
  assert.equal(questionRefSlug('a'.repeat(140)),null);
  assert.equal(questionRefSlug(7),null);
});

function v2Row(overrides={},snapshotOverrides={}){
  return {
    id:1,user_id:2,week_id:null,pair_group_id:null,question_slug:'graphs-easy',language:'javascript',
    code:'function x(){}',results_json:'[]',passed_count:2,total_count:3,created_at:'2026-09-20 10:00:00',
    test_cases_snapshot:JSON.stringify({
      source:'original-catalog',version:1,total_count:3,attestation_version:2,
      attestation_key_id:'0123456789abcdef',attestation:'a'.repeat(64),...snapshotOverrides,
    }),
    ...overrides,
  };
}

function v3Row(overrides={},snapshotOverrides={}){
  const code='function y(){ return 1; }';
  return v2Row({week_id:10,pair_group_id:20,code,...overrides},{
    attestation_version:3,week_id:10,pair_group_id:20,
    code_hash:createHash('sha256').update(code,'utf8').digest('hex'),
    document_revision:4,document_state_hash:'b'.repeat(64),document_version:'c'.repeat(64),
    ...snapshotOverrides,
  });
}

test('a run counts only when its server attestation verifies, with exactly the attested fields',()=>{
  const calls=[];
  const verify=(...args)=>{ calls.push(args); return true; };
  assert.deepEqual(verifiedRunAttempt(v2Row(),verify),{slug:'graphs-easy',at:Date.parse('2026-09-20T10:00:00Z')});
  assert.deepEqual(calls[0],['a'.repeat(64),'0123456789abcdef',{
    userId:2,questionSlug:'graphs-easy',questionVersion:1,language:'javascript',passedCount:2,totalCount:3,resultsJson:'[]',
  },2]);
  assert.deepEqual(verifiedRunAttempt(v3Row(),verify)?.slug,'graphs-easy');
  assert.deepEqual(calls[1][2],{
    userId:2,questionSlug:'graphs-easy',questionVersion:1,language:'javascript',passedCount:2,totalCount:3,resultsJson:'[]',
    weekId:10,pairGroupId:20,codeHash:createHash('sha256').update('function y(){ return 1; }','utf8').digest('hex'),
    documentRevision:4,documentStateHash:'b'.repeat(64),documentVersion:'c'.repeat(64),
  });
  assert.equal(calls[1][3],3);
  // The stored code is not read: a v3 run verifies from its snapshot alone.
  const withoutCode=v3Row();
  delete withoutCode.code;
  assert.equal(verifiedRunAttempt(withoutCode,verify)?.slug,'graphs-easy');

  assert.equal(verifiedRunAttempt(v2Row(),()=>false),null);
  assert.equal(verifiedRunAttempt(v2Row(),()=>'yes'),null);
  assert.equal(verifiedRunAttempt(v2Row(),()=>{ throw new Error('bad key'); }),null);
  assert.equal(verifiedRunAttempt(v2Row(),null),null);
  assert.equal(verifiedRunAttempt(null,verify),null);
  for(const row of [
    v2Row({question_slug:'Not A Slug'}),
    v2Row({user_id:0}),
    v2Row({test_cases_snapshot:null}),
    v2Row({test_cases_snapshot:'x'.repeat(33*1024)}),
    v2Row({test_cases_snapshot:'{not json'}),
    v2Row({test_cases_snapshot:'null'}),
    v2Row({},{source:'legacy'}),
    v2Row({},{version:0}),
    v2Row({passed_count:4}),
    v2Row({passed_count:-1}),
    v2Row({total_count:'x'}),
    v2Row({},{total_count:2}),
    v2Row({language:null}),
    v2Row({results_json:null}),
    v2Row({},{attestation_version:1}),
    v3Row({week_id:null}),
    v3Row({pair_group_id:null}),
    v3Row({week_id:11}),
    v3Row({pair_group_id:21}),
    v3Row({},{code_hash:'nothex'}),
    v3Row({},{code_hash:undefined}),
    v3Row({},{document_revision:0}),
    v3Row({},{document_state_hash:'nothex'}),
    v3Row({},{document_state_hash:undefined}),
    v3Row({},{document_version:null}),
  ]){
    assert.equal(verifiedRunAttempt(row,verify),null,row.test_cases_snapshot);
  }
});

test('topics are tags (or the pattern without tags) and difficulty has three levels',()=>{
  assert.deepEqual(exerciseTopics({tags:[' Graphs ','graphs','',7,'trees'],type:'graph'}),['graphs','trees']);
  assert.deepEqual(exerciseTopics({tags:[],type:' Sliding-Window '}),['sliding-window']);
  assert.deepEqual(exerciseTopics({}),[]);
  assert.equal(topicLabel('dynamic-programming'),'dynamic programming');
  assert.equal(topicLabel(null),'');
  assert.deepEqual(DIFFICULTY_LEVELS,['Easy','Medium','Hard']);
  assert.equal(difficultyLevel('Medium'),1);
  assert.equal(difficultyLevel('Impossible'),-1);
  assert.deepEqual(normalizeSuggestionCatalogue([
    {slug:'a',version:1,title:' A ',difficulty:'Easy',tags:['x']},
    {slug:'a',version:2,title:'Duplicate'},
    {slug:'Bad Slug'},
    {slug:'b',version:'x',title:'',difficulty:'Unknown',type:'pattern'},
    null,
  ]),[
    {slug:'a',version:1,title:'A',difficulty:'Easy',topics:['x']},
    {slug:'b',version:null,title:'b',difficulty:null,topics:['pattern']},
  ]);
  assert.deepEqual(normalizeSuggestionCatalogue('nope'),[]);
});

test('recent difficulty is the hardest of the three most recent attempts',()=>{
  const levels=new Map([['e1',0],['e2',0],['m',1],['h',2],['u',-1]]);
  assert.equal(recentDifficultyLevel(new Map(),levels),null);
  assert.equal(recentDifficultyLevel(new Map([['u',5]]),levels),null);
  assert.equal(recentDifficultyLevel(new Map([['e1',3],['m',2],['h',1]]),levels),2);
  // The Hard attempt is the fourth most recent, so it no longer counts.
  assert.equal(recentDifficultyLevel(new Map([['e1',5],['e2',4],['m',3],['h',1]]),levels),1);
  // Equal times are ordered by slug so the window is deterministic: the
  // window is e1, e2 and h, whatever the insertion order.
  assert.equal(recentDifficultyLevel(new Map([['m',1],['h',1],['e2',1],['e1',1]]),levels),2);
  assert.equal(recentDifficultyLevel(new Map([['m',1],['e2',1],['e1',1],['u',1]]),levels),1);
});

test('with no history: three Easy exercises, least-covered topics first, ties broken by slug',()=>{
  const result=selectExerciseSuggestions({exercises:CATALOGUE});
  assert.equal(result.emptyReason,null);
  assert.equal(result.recentLevel,null);
  assert.equal(result.targetLevel,0);
  // All Easy candidates tie on coverage (0) and difficulty; slug order breaks
  // the tie. After arrays-easy-a, "arrays" counts as covered, so arrays-easy-b
  // (still 0 through "sorting") ties with graphs-easy and wins by slug.
  assert.deepEqual(slugs(result),['arrays-easy-a','arrays-easy-b','graphs-easy']);
  assert.deepEqual(result.suggestions[0],{
    slug:'arrays-easy-a',version:1,title:'Arrays A',difficulty:'Easy',topic:'arrays',
    reason:{
      code:'uncovered_topic',difficulty_step:'start',
      text:'You haven’t practised arrays yet. An Easy exercise is a good place to start.',
    },
  });
  // The real catalogue behaves the same way and never repeats a slug.
  const real=selectExerciseSuggestions({exercises:realCatalogue});
  assert.equal(real.suggestions.length,MAX_SUGGESTIONS);
  assert.ok(real.suggestions.every(suggestion=>suggestion.difficulty==='Easy'));
  assert.equal(new Set(slugs(real)).size,MAX_SUGGESTIONS);
});

test('a pick counts toward coverage, so the next pick prefers a different topic',()=>{
  const catalogue=[
    {slug:'a-graphs-1',difficulty:'Easy',tags:['graphs']},
    {slug:'b-graphs-2',difficulty:'Easy',tags:['graphs']},
    {slug:'c-trees',difficulty:'Easy',tags:['trees']},
  ];
  assert.deepEqual(slugs(selectExerciseSuggestions({exercises:catalogue,limit:2})),['a-graphs-1','c-trees']);
});

test('when everything has been attempted there are no suggestions and an explicit empty reason',()=>{
  const all=Object.fromEntries(CATALOGUE.map((exercise,index)=>[exercise.slug,index]));
  const result=selectExerciseSuggestions({exercises:CATALOGUE,mine:history(all)});
  assert.deepEqual(result.suggestions,[]);
  assert.equal(result.emptyReason,'all_attempted');
  // Split across two partners it is still "all attempted".
  const mine=history({'arrays-easy-a':1,'arrays-easy-b':1,'graphs-easy':1,'graphs-medium':1});
  const theirs=new Set(['graphs-hard','strings-medium','trees-hard']);
  assert.equal(selectExerciseSuggestions({exercises:CATALOGUE,mine,partnerAttempted:theirs,pair:true}).emptyReason,'all_attempted');
  assert.equal(selectExerciseSuggestions({exercises:[]}).emptyReason,'no_exercises');
});

test('hidden exercises are never suggested and the next best one takes their place',()=>{
  const result=selectExerciseSuggestions({exercises:CATALOGUE,hidden:['arrays-easy-a','graphs-easy']});
  assert.deepEqual(slugs(result),['arrays-easy-b','graphs-medium','strings-medium']);
  const everythingLeft=selectExerciseSuggestions({
    exercises:CATALOGUE,
    mine:history({'arrays-easy-a':1,'arrays-easy-b':1,'graphs-easy':1,'graphs-medium':1,'graphs-hard':1}),
    hidden:['strings-medium','trees-hard','not-in-catalogue'],
  });
  assert.deepEqual(everythingLeft.suggestions,[]);
  assert.equal(everythingLeft.emptyReason,'all_hidden');
  // Hiding is not attempting: a hidden exercise adds no coverage.
  assert.equal(selectExerciseSuggestions({exercises:CATALOGUE,hidden:['arrays-easy-a']})
    .suggestions[0].reason.code,'uncovered_topic');
  assert.deepEqual(slugs(selectExerciseSuggestions({exercises:CATALOGUE,hidden:'nope'})).length,3);
});

test('difficulty steps one level above the recent level and stops at Hard',()=>{
  // Recent Easy -> Medium is preferred among equally uncovered topics.
  const fromEasy=selectExerciseSuggestions({exercises:CATALOGUE,mine:history({'arrays-easy-a':10}),limit:1});
  assert.equal(fromEasy.targetLevel,1);
  assert.deepEqual(fromEasy.suggestions.map(item=>[item.slug,item.reason.difficulty_step,item.reason.text]),[
    ['graphs-medium','step_up','You haven’t practised graphs yet. One step up from your recent Easy exercises.'],
  ]);
  // Recent Medium -> Hard.
  const fromMedium=selectExerciseSuggestions({exercises:CATALOGUE,mine:history({'strings-medium':10}),limit:1});
  assert.equal(fromMedium.targetLevel,2);
  assert.equal(fromMedium.suggestions[0].slug,'graphs-hard');
  assert.equal(fromMedium.suggestions[0].reason.difficulty_step,'step_up');
  // Recent Hard stays at Hard.
  const fromHard=selectExerciseSuggestions({exercises:CATALOGUE,mine:history({'graphs-hard':10}),limit:1});
  assert.equal(fromHard.targetLevel,2);
  assert.equal(fromHard.suggestions[0].slug,'trees-hard');
  assert.equal(fromHard.suggestions[0].reason.difficulty_step,'same');
  assert.match(fromHard.suggestions[0].reason.text,/The same level as your recent Hard exercises\.$/);
  // Only the three most recent attempts set the level: an old Hard is ignored.
  const old=selectExerciseSuggestions({exercises:CATALOGUE,mine:history({
    'trees-hard':1,'arrays-easy-a':5,'arrays-easy-b':6,'graphs-easy':7,
  }),limit:1});
  assert.equal(old.recentLevel,0);
  assert.equal(old.targetLevel,1);
});

test('equally distant levels prefer the easier one, and coverage outranks difficulty',()=>{
  const catalogue=[
    {slug:'easy-one',difficulty:'Easy',tags:['x']},
    {slug:'hard-one',difficulty:'Hard',tags:['y']},
    {slug:'medium-done',difficulty:'Medium',tags:['z']},
  ];
  const result=selectExerciseSuggestions({exercises:catalogue,mine:history({'medium-done':1})});
  // Target Hard (one above Medium): Hard first; then Easy.
  assert.deepEqual(slugs(result),['hard-one','easy-one']);
  assert.equal(result.suggestions[1].reason.difficulty_step,'easier');
  assert.match(result.suggestions[1].reason.text,/Easier than your recent Medium exercises\.$/);

  // A recent Easy sets the target to Medium. With no Medium left, Easy and
  // Hard are both one step away; the easier one wins even though "a-hard"
  // sorts first by slug.
  const tie=[
    {slug:'a-hard',difficulty:'Hard',tags:['p']},
    {slug:'b-easy',difficulty:'Easy',tags:['q']},
    {slug:'c-easy-done',difficulty:'Easy',tags:['r']},
  ];
  const easierWins=selectExerciseSuggestions({exercises:tie,mine:history({'c-easy-done':1}),limit:1});
  assert.equal(easierWins.targetLevel,1);
  assert.deepEqual(slugs(easierWins),['b-easy']);

  const coverage=[
    {slug:'covered-medium',difficulty:'Medium',tags:['arrays']},
    {slug:'fresh-easy',difficulty:'Easy',tags:['graphs']},
    {slug:'done-easy',difficulty:'Easy',tags:['arrays']},
  ];
  const fresh=selectExerciseSuggestions({exercises:coverage,mine:history({'done-easy':1})});
  // Target is Medium, but graphs is uncovered while arrays is not.
  assert.deepEqual(slugs(fresh),['fresh-easy','covered-medium']);
  assert.deepEqual(fresh.suggestions[1].reason,{
    code:'least_covered_topic',difficulty_step:'step_up',
    text:'You have practised arrays in only 1 exercise. One step up from your recent Easy exercises.',
  });
  assert.equal(fresh.suggestions[0].reason.difficulty_step,'same');
});

test('pair wording speaks for both partners and counts the union once',()=>{
  const catalogue=[
    {slug:'a',difficulty:'Easy',tags:['arrays']},
    {slug:'b',difficulty:'Easy',tags:['arrays']},
    {slug:'c',difficulty:'Medium',tags:['arrays']},
    {slug:'d',difficulty:'Medium',tags:['graphs']},
  ];
  const result=selectExerciseSuggestions({
    exercises:catalogue,mine:history({a:2}),partnerAttempted:['a','b'],pair:true,
  });
  assert.deepEqual(slugs(result),['d','c']);
  assert.equal(result.suggestions[0].reason.text,'Neither of you has practised graphs yet. One step up from your recent Easy exercises.');
  assert.equal(result.suggestions[1].reason.text,'Together you have practised arrays in only 2 exercises. One step up from your recent Easy exercises.');
});

test('exercises without topics or rated difficulty still get a plain reason',()=>{
  const result=selectExerciseSuggestions({exercises:[
    {slug:'mystery',title:'Mystery'},
  ]});
  assert.deepEqual(result.suggestions[0].reason,{
    code:'new_exercise',difficulty_step:'unrated',
    text:'You haven’t tried this exercise yet. Its difficulty is not rated.',
  });
  const pair=selectExerciseSuggestions({exercises:[{slug:'mystery'}],pair:true});
  assert.match(pair.suggestions[0].reason.text,/^Neither of you has tried this exercise yet\./);
  const medium=selectExerciseSuggestions({exercises:[{slug:'m',difficulty:'Medium',tags:['x']}]});
  assert.equal(medium.suggestions[0].reason.text,'You haven’t practised x yet. A Medium exercise to start with.');
  const stretch=selectExerciseSuggestions({
    exercises:[{slug:'e',difficulty:'Easy',tags:['x']},{slug:'h',difficulty:'Hard',tags:['y']}],
    mine:{e:'not-a-number'},
  });
  assert.equal(stretch.suggestions[0].reason.difficulty_step,'stretch');
  assert.match(stretch.suggestions[0].reason.text,/A stretch above your recent Easy exercises\.$/);
});

test('the limit is clamped to three and unknown or malformed history is ignored',()=>{
  assert.equal(selectExerciseSuggestions({exercises:CATALOGUE,limit:10}).suggestions.length,3);
  assert.equal(selectExerciseSuggestions({exercises:CATALOGUE,limit:0}).suggestions.length,3);
  assert.equal(selectExerciseSuggestions({exercises:CATALOGUE,limit:1}).suggestions.length,1);
  assert.equal(selectExerciseSuggestions({exercises:CATALOGUE,mine:history({'retired-exercise':1})}).recentLevel,null);
  for(const partnerAttempted of [null,7,'graphs-easy',['retired-exercise']]){
    assert.equal(selectExerciseSuggestions({exercises:CATALOGUE,partnerAttempted}).suggestions[0].slug,'arrays-easy-a');
  }
  assert.equal(selectExerciseSuggestions({exercises:CATALOGUE,mine:'nope'}).targetLevel,0);
  assert.equal(selectExerciseSuggestions().emptyReason,'no_exercises');
});

test('attempted markers are one boolean pair per attempted catalogue exercise',()=>{
  assert.deepEqual(attemptedMarkers(CATALOGUE,history({'graphs-easy':1,'retired':2}),{'graphs-easy':3,'arrays-easy-a':4}),[
    {slug:'arrays-easy-a',by_me:false,by_partner:true},
    {slug:'graphs-easy',by_me:true,by_partner:true},
  ]);
  assert.deepEqual(attemptedMarkers(CATALOGUE,null,undefined),[]);
});

test('readiness probes the read-only schema once per database and retries after a failure',async()=>{
  const statements=[];
  let fail=true;
  const db={async execute(sql){ statements.push(sql); if(fail) throw new Error('missing table'); return {rows:[]}; }};
  await assert.rejects(ensureExerciseSuggestionsReadiness(db),/missing table/);
  fail=false;
  await ensureExerciseSuggestionsReadiness(db);
  const probed=statements.length;
  await ensureExerciseSuggestionsReadiness(db);
  assert.equal(statements.length,probed);
  assert.ok(statements.every(sql=>/^SELECT [\s\S]+ LIMIT 0$/.test(sql.trim())));
  assert.ok(!statements.some(sql=>/circle_memberships/.test(sql)));

  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.TURSO_DATABASE_URL='file:exercise-suggestions-readiness.db';
  const membership=[];
  const shared={async execute(sql){ membership.push(sql); return {rows:[]}; }};
  await ensureExerciseSuggestionsReadiness(shared);
  await ensureExerciseSuggestionsReadiness({async execute(){ throw new Error('not reached'); }});
  assert.ok(membership.some(sql=>/circle_memberships/.test(sql)));
  assert.ok(membership.some(sql=>/FROM circles/.test(sql)));
});

test('history and audience readers validate their inputs before touching the database',async()=>{
  const untouched={
    async execute(){ throw new Error('database must not be read'); },
    async batch(){ throw new Error('database must not be read'); },
  };
  await assert.rejects(readMemberAttempts(untouched,{userId:0,slugs:['a']}),TypeError);
  assert.deepEqual(await readMemberAttempts(untouched,{userId:2,slugs:['Bad Slug']}),new Map());
  assert.deepEqual(await readMemberAttempts(untouched,{userId:2,slugs:null}),new Map());
  await assert.rejects(resolveSuggestionAudience(untouched,{viewerId:'x'}),TypeError);
  assert.deepEqual(await resolveSuggestionAudience(untouched,{viewerId:2}),{roomId:null,partnerIds:[]});
  // A room the database returns nothing for is not authorized.
  const room={roomId:'week_1_pair_2',weekId:1,pairGroupId:2};
  assert.equal(await resolveSuggestionAudience({async execute(){ return {}; }},{viewerId:2,room}),null);
  // Duplicate, self and malformed partner rows collapse to the real partners.
  const partners=await resolveSuggestionAudience({async execute(){
    return {rows:[{partner_id:9},{partner_id:4},{partner_id:4},{partner_id:2},{partner_id:null},{partner_id:'x'},{partner_id:7}]};
  }},{viewerId:2,room});
  assert.deepEqual(partners,{roomId:'week_1_pair_2',partnerIds:[4,7]});
  await assert.rejects(readExerciseSuggestions(null,{viewerId:2}),TypeError);
  await assert.rejects(readExerciseSuggestions({},{viewerId:2}),TypeError);
  await assert.rejects(readExerciseSuggestions({async execute(){ return {rows:[]}; }},{viewerId:2}),TypeError);
  assert.deepEqual(memberAttemptStatements(2,['Bad Slug']),[]);
  // With no catalogue there is nothing to read.
  const noCatalogue=await readExerciseSuggestions(untouched,{viewerId:2,exercises:[]});
  assert.equal(noCatalogue.empty_reason,'no_exercises');
  assert.deepEqual(noCatalogue.attempted,[]);
  assert.throws(()=>memberAttemptStatements(-1,['a']),TypeError);
});

test('history reading is one bounded read batch that keeps only the member\'s own verified rows',async()=>{
  const batches=[];
  const db={async batch(statements,mode){
    batches.push({statements,mode});
    return [{rows:[
      v2Row({user_id:2,question_slug:'graphs-easy',created_at:'2026-09-20 10:00:00'}),
      v2Row({user_id:2,question_slug:'graphs-easy',created_at:'2026-09-21 10:00:00'}),
      v2Row({user_id:9,question_slug:'trees-hard'}),
      v2Row({user_id:2,question_slug:'not-in-catalogue'}),
    ]},{rows:[
      {question_ref:'arrays-easy-a@1',completed_at:'2026-09-22T10:00:00.000Z'},
      {question_ref:'arrays-easy-a',completed_at:'2026-09-01T10:00:00.000Z'},
      {question_ref:'legacy-two-sum',completed_at:'2026-09-01T10:00:00.000Z'},
      {question_ref:null,completed_at:null},
    ]}];
  }};
  const slugList=CATALOGUE.map(exercise=>exercise.slug).concat('graphs-easy');
  const attempts=await readMemberAttempts(db,{userId:2,slugs:slugList,verifyAttestation:()=>true});
  assert.deepEqual([...attempts.entries()],[
    ['graphs-easy',Date.parse('2026-09-21T10:00:00Z')],
    ['arrays-easy-a',Date.parse('2026-09-22T10:00:00.000Z')],
  ]);
  assert.equal(batches.length,1);
  assert.equal(batches[0].mode,'read');
  const [runs,sessions]=batches[0].statements;
  // One VALUES row per distinct catalogue slug, then the member, then the
  // per-exercise limit; the member filter sits inside the per-slug lookup.
  assert.deepEqual(runs.args,[...CATALOGUE.map(exercise=>exercise.slug),2,RUNS_PER_EXERCISE]);
  assert.match(runs.sql,/WHERE recent\.user_id=\? AND recent\.question_slug=wanted\.slug/);
  assert.match(runs.sql,/ORDER BY recent\.id DESC LIMIT \?/);
  assert.doesNotMatch(runs.sql,/\bcode\b/);
  assert.doesNotMatch(runs.sql,/ROW_NUMBER/);
  assert.deepEqual(sessions.args,[2,200]);
  assert.match(sessions.sql,/CROSS JOIN pair_room_snapshots/);
  assert.match(sessions.sql,/CROSS JOIN pair_code_documents/);
  const empty=await readMemberAttempts({async batch(){ return [{},{}]; }},{userId:2,slugs:['graphs-easy'],verifyAttestation:()=>true});
  assert.equal(empty.size,0);
  assert.equal(memberAttemptsFromResults(2,['graphs-easy'],undefined,()=>true).size,0);
});

test('partners change only exclusion and coverage, never the recent difficulty or a reason',()=>{
  // Review repro: the member's own attempts are Easy; a partner did one Medium.
  // Moving the partner's attempt from before to after the member's attempts
  // must not change anything, because partner times are never accepted.
  const mine=history({
    'arrays-easy-a':Date.parse('2026-10-11T10:00:00Z'),
    'arrays-easy-b':Date.parse('2026-10-12T10:00:00Z'),
    'graphs-easy':Date.parse('2026-10-13T10:00:00Z'),
  });
  const earlier=selectExerciseSuggestions({exercises:CATALOGUE,mine,pair:true,
    partnerAttempted:new Map([['strings-medium',Date.parse('2026-10-10T10:00:00Z')]])});
  const later=selectExerciseSuggestions({exercises:CATALOGUE,mine,pair:true,
    partnerAttempted:new Map([['strings-medium',Date.parse('2026-10-14T10:00:00Z')]])});
  assert.equal(JSON.stringify(later),JSON.stringify(earlier));
  assert.equal(earlier.recentLevel,0);
  assert.ok(earlier.suggestions.every(item=>/recent Easy exercises\.$/.test(item.reason.text)));
  // The partner's exercise is excluded and its topic counts as covered.
  assert.ok(!slugs(earlier).includes('strings-medium'));
  const solo=selectExerciseSuggestions({exercises:CATALOGUE,mine});
  assert.ok(slugs(solo).includes('strings-medium'));
});

test('partners\' runs in the current room join the recent difficulty for both partners',()=>{
  const mine=history({'arrays-easy-a':Date.parse('2026-10-11T10:00:00Z')});
  const without=selectExerciseSuggestions({exercises:CATALOGUE,mine,partnerAttempted:['graphs-hard'],pair:true});
  assert.equal(without.recentLevel,0);
  const withRoom=selectExerciseSuggestions({exercises:CATALOGUE,mine,partnerAttempted:['graphs-hard'],pair:true,
    roomAttempts:new Map([['graphs-hard',Date.parse('2026-10-12T10:00:00Z')],['retired-exercise',9]])});
  assert.equal(withRoom.recentLevel,2);
  assert.ok(withRoom.suggestions.every(item=>/recent Hard exercises\.$/.test(item.reason.text)));
  // Only the newest three count: an old room run is outweighed by newer own work.
  const older=selectExerciseSuggestions({exercises:CATALOGUE,pair:true,
    mine:history({'arrays-easy-a':5,'arrays-easy-b':6,'graphs-easy':7}),
    roomAttempts:{'graphs-hard':1}});
  assert.equal(older.recentLevel,0);
  assert.equal(selectExerciseSuggestions({exercises:CATALOGUE,roomAttempts:{'graphs-hard':'x'}}).recentLevel,2);
  // A slug in both keeps its newest time, whichever source it came from.
  const both=history({'graphs-hard':10,'arrays-easy-a':8,'arrays-easy-b':7,'graphs-easy':6});
  assert.equal(selectExerciseSuggestions({exercises:CATALOGUE,mine:both,roomAttempts:{'graphs-hard':1}}).recentLevel,2);
  assert.equal(selectExerciseSuggestions({exercises:CATALOGUE,mine:history({'graphs-hard':1,'arrays-easy-a':8,'arrays-easy-b':7,'graphs-easy':6}),
    roomAttempts:{'graphs-hard':10}}).recentLevel,2);
});

test('room attempts keep only partners\' verified runs in exactly this room',()=>{
  const room={roomId:'week_10_pair_20',weekId:10,pairGroupId:20};
  const rows=[
    {...v3Row({user_id:4}),created_at:'2026-10-01 10:00:00'},
    {...v3Row({user_id:4,question_slug:'graphs-hard'}),created_at:'2026-10-02 10:00:00'},
    v3Row({user_id:9,question_slug:'trees-hard'}),
    v3Row({user_id:4,question_slug:'strings-medium',week_id:11},{week_id:11}),
    v3Row({user_id:4,question_slug:'arrays-easy-a',pair_group_id:21},{pair_group_id:21}),
    v3Row({user_id:4,question_slug:'not-in-catalogue'}),
    v2Row({user_id:4,question_slug:'arrays-easy-b'}),
  ];
  const attempts=roomAttemptsFromResult({rows},{
    room,partnerIds:[4],slugs:CATALOGUE.map(exercise=>exercise.slug),verifyAttestation:()=>true,
  });
  assert.deepEqual([...attempts.keys()],['graphs-easy','graphs-hard']);
  assert.equal(roomAttemptsFromResult(undefined,{room,partnerIds:[4],slugs:null,verifyAttestation:()=>true}).size,0);
  assert.equal(roomAttemptsFromResult({rows},{room,partnerIds:[4],slugs:['graphs-easy'],verifyAttestation:()=>false}).size,0);
});

test('the hidden count covers only hidden exercises that could be suggested',()=>{
  const result=selectExerciseSuggestions({
    exercises:CATALOGUE,mine:history({'arrays-easy-a':1}),partnerAttempted:['graphs-easy'],
    hidden:['arrays-easy-a','graphs-easy','strings-medium','retired-exercise'],
  });
  assert.equal(result.hiddenCount,1);
  assert.equal(selectExerciseSuggestions({exercises:CATALOGUE}).hiddenCount,0);
});
