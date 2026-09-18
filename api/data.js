import { captureSentryException, captureSentryMessage, getClient, getAdminEmails, getJwtSecret, initSentry, isSentryConfigured, verifyMutationOrigin, verifyRequestAuth } from './_db.js';
import { createEvaluationSuite, getPublicExercise, listPublicExercises } from './_catalog.js';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

function isAdminCheck(email, flag){
  if (flag) return true;
  if (!email) return false;
  try{ return getAdminEmails().has(String(email).toLowerCase().trim()); }catch{ return false; }
}
async function getCallerAdmin(db, payload){
  let callerEmail = '';
  const callerId = payload.id||payload.uid;
  let callerIsAdminFlag=false, callerDbRow=null;
  if (callerId){ try{ const cr=await db.execute({ sql:`SELECT id,email,is_admin FROM auth_accounts WHERE id=?`, args:[callerId]}); if(cr.rows.length){ callerDbRow=cr.rows[0]; callerEmail=String(cr.rows[0].email||'').toLowerCase().trim(); callerIsAdminFlag=!!cr.rows[0].is_admin; }}catch{} }
  const callerIsAdmin = !!callerDbRow && isAdminCheck(callerEmail, callerIsAdminFlag);
  return {callerEmail, callerId, callerIsAdminFlag, callerIsAdmin};
}
async function requireAdminDT(req,res){
  const payload=verifyRequestAuth(req);
  if (!payload){ res.status(401).json({ error:'authentication required' }); return null; }
  const db=getClient(); await ensureBaseTables(db); await ensureProfileMigrations(db);
  const ctx=await getCallerAdmin(db,payload);
  if(!ctx.callerIsAdmin){ res.status(403).json({ error:'admin only', you_are:ctx.callerEmail||'unknown' }); return null; }
  return {db, payload, ...ctx};
}

// ----- LeetCode proxy + DB cache helpers -----
function htmlToText(html){
  if(!html) return '';
  let t = String(html);
  t = t.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi,'\n\n').replace(/<\/li>/gi,'\n').replace(/<\/div>/gi,'\n');
  t = t.replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
  t = t.replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').replace(/ {2,}/g,' ');
  return t.trim().slice(0,12000);
}
function parseLeetConstraints(contentHtml){
  const text = htmlToText(contentHtml);
  // naive: look for lines like "Constraints:" or bullet list
  const m = text.match(/Constraints:\s*([\s\S]{0,800})/i);
  if (m) return m[1].trim().split('\n').slice(0,8).join(' | ').slice(0,1000);
  // fallback: look for <code> with exponents
  return '';
}
// Known problem metadata for smart chunking + enrichment
const KNOWN_LEET = {
  'two-sum': { params:['nums','target'], examples:3, category:'array' },
  'valid-parentheses': { params:['s'], examples:3, category:'stack' },
  'merge-two-sorted-lists': { params:['l1','l2'], examples:2, category:'linked-list' },
  'lru-cache': { params:['operations'], examples:1, category:'design' },
  'design-twitter': { params:['scenario'], examples:1, category:'system-design' },
};
function cleanLeetLine(line){
  let l=String(line||'').trim();
  if(!l) return '';
  // Leet strips "nums = [2,7,11,15]" -> "[2,7,11,15]"
  const eq = l.indexOf('=');
  if(eq>0 && eq<30){
    const rhs = l.slice(eq+1).trim();
    // avoid capturing comparator (==) quickly
    if(rhs) return rhs;
  }
  return l;
}
function tryParseJsonish(s){
  try{ return JSON.parse(s); }catch{
    // leet sometimes uses '[1,2,4]' which is JSON, but '"()"' is JSON string too
    // fallback: if looks like Python list
    try{ if(s.startsWith('[') && s.endsWith(']')) return JSON.parse(s.replace(/'/g,'"')); }catch{}
    return null;
  }
}
function parsePreExamples(contentHtml){
  const out=[];
  if(!contentHtml) return out;
  const preMatches = [...String(contentHtml).matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/gi)];
  for(const pm of preMatches.slice(0,6)){
    const raw = pm[1];
    const text = htmlToText(raw);
    // Normalize: look for Input:/Output: pairs, possibly multi-line
    // Common format: Input: X\nOutput: Y\nExplanation: Z
    // Split using regex with lookahead
    const lines = text.split('\n').map(l=>l.trim()).filter(Boolean);
    let curInput=null, curOutput=null, bufInput=[];
    for(let i=0;i<lines.length;i++){
      const l=lines[i];
      const low=l.toLowerCase();
      if(low.startsWith('input:')){
        if(curInput && curOutput!=null){
          out.push({inputRaw: bufInput.join(' ').slice(6).trim() || curInput, outputRaw:curOutput});
        }
        bufInput=[l];
        curInput=l.slice(6).trim();
        curOutput=null;
      } else if(low.startsWith('output:')){
        curOutput=l.slice(7).trim();
        // collect following lines if output seems incomplete '[' missing ']'
        if(curOutput && curOutput.startsWith('[') && !curOutput.endsWith(']')){
          // try next line join
          if(i+1<lines.length && !lines[i+1].toLowerCase().startsWith('explanation')) curOutput+=lines[++i];
        }
        if(curInput) {
          out.push({inputRaw: (bufInput.length? bufInput.join(' ').slice(6).trim(): curInput), outputRaw:curOutput});
          curInput=null; bufInput=[]; curOutput=null;
        } else if(bufInput.length){
          out.push({inputRaw: bufInput.join(' ').slice(6).trim(), outputRaw:curOutput});
          bufInput=[]; curOutput=null;
        }
      } else if(low.startsWith('explanation:')){
        // end of example, already pushed
        curInput=null; bufInput=[]; curOutput=null;
      } else {
        // continuation of Input: if we are still in Input collection and no Output yet
        if(bufInput.length && curOutput===null){
          bufInput.push(l);
          curInput = bufInput.join(' ').slice(6).trim();
        }
      }
    }
    if(curInput && curOutput){
      out.push({inputRaw:curInput, outputRaw:curOutput});
    }
    if(out.length>=8) break;
  }
  return out;
}
function inputRawToObj(inputRaw, paramNames){
  // inputRaw like "nums = [2,7,11,15], target = 9" or "[2,7,11,15], 9" or "s = \"()\""
  if(!inputRaw) return {};
  const s = String(inputRaw).trim();
  const obj={};
  // Try split by comma but not inside brackets
  // First attempt: detect "a = b, c = d" pattern
  if(s.includes('=') ){
    // split by ',' then extract each k=v
    const parts=[];
    let depth=0, cur='';
    for(let ch of s){
      if(ch==='['||ch==='{'||ch==='(') depth++;
      if(ch===']'||ch==='}'||ch===')') depth--;
      if(ch===',' && depth===0){ parts.push(cur); cur=''; continue; }
      cur+=ch;
    }
    if(cur) parts.push(cur);
    for(const p of parts){
      const trimmed=p.trim();
      if(!trimmed) continue;
      const eq=trimmed.indexOf('=');
      if(eq>0){
        const k=trimmed.slice(0,eq).trim();
        const v=trimmed.slice(eq+1).trim();
        const pv = tryParseJsonish(v);
        obj[k]= pv!==null ? pv : v.replace(/^"|"$/g,'').replace(/^'|'$/g,'');
      } else {
        // positional without name – map sequentially
        const pv=tryParseJsonish(trimmed);
        const name = paramNames && paramNames[Object.keys(obj).length] ? paramNames[Object.keys(obj).length] : `arg${Object.keys(obj).length}`;
        obj[name]= pv!==null? pv: trimmed;
      }
    }
    if(Object.keys(obj).length) return obj;
  }
  // No '=', try single value positional
  const p = tryParseJsonish(s);
  if(p!==null && paramNames && paramNames[0]){
    if(Array.isArray(p) && paramNames.length===1) return {[paramNames[0]]: p};
    if(typeof p!=='object' || Array.isArray(p)) {
      const single={}; single[paramNames[0]]=p; return single;
    }
    return p;
  }
  // multi values without '=' but separated? ExampleTwoSum exampleTestcases per line grouping uses separate lines. This helper expects single block - fallback raw string
  return {raw:s};
}
function buildTestCasesFromExampleTestcases(exampleTestcases, content){
  const out=[];
  const known = content ? null : null;
  if(content){
    const preEx = parsePreExamples(content);
    for(const pe of preEx.slice(0,6)){
      const slugLower = ''; // caller will map
      // Try to convert inputRaw directly; param names extracted later by caller
      out.push({ __preInput: pe.inputRaw, __preOutput: pe.outputRaw, raw: `${pe.inputRaw} => ${pe.outputRaw}`, __isPre:true });
      if(out.length>=10) break;
    }
  }
  if (!exampleTestcases){
    // only pre examples
    return out.filter(o=>o.__isPre).map(o=>({input:o.__preInput, expect:o.__preOutput, raw:o.raw}));
  }
  const lines = String(exampleTestcases).split('\n').map(s=>s.trim()).filter(Boolean);
  for (let i=0;i<lines.length;i++){
    const raw = lines[i];
    out.push({ input: raw, expect:null, raw });
    if (out.length>=12) break;
  }
  return out;
}
function smartChunkExampleTestcases(slug, exampleTestcases, content){
  // Unified smart chunker returning {input: JSONstring, expect: JSONstring|null, raw}
  const known = KNOWN_LEET[slug] || null;
  const paramNames = known?.params || null;
  const preCases = parsePreExamples(content); // [{inputRaw, outputRaw}]
  const enriched=[];

  // Use pre cases first as gold – they have both input & output
  for(const pc of preCases){
    const inObj = inputRawToObj(pc.inputRaw, paramNames);
    let inStr;
    try{ inStr = JSON.stringify(inObj); }catch{ inStr = JSON.stringify({raw:pc.inputRaw}); }
    const outVal = tryParseJsonish(pc.outputRaw) ?? pc.outputRaw;
    let outStr;
    try{ outStr = JSON.stringify(outVal); }catch{ outStr = String(pc.outputRaw); }
    enriched.push({input:inStr, expect:outStr, raw:`${pc.inputRaw} -> ${pc.outputRaw}`, __source:'pre'});
  }

  if(exampleTestcases){
    const rawLines = String(exampleTestcases).split('\n').map(s=>cleanLeetLine(s.trim())).filter(Boolean);
    const paramCount = paramNames ? paramNames.length : (rawLines.length%2===0 && rawLines.length>=2 ? 2 : 1);
    // If paramCount inferred 2 but lines groups maybe includes expected third line for some APIs (rare)
    let idx=0;
    let loopGuard=0;
    while(idx < rawLines.length && loopGuard<12){
      loopGuard++;
      const group = rawLines.slice(idx, idx+paramCount);
      if(group.length < paramCount) break;
      const inObj={};
      let ok=true;
      for(let pi=0; pi<paramCount; pi++){
        const line = group[pi];
        const pv = tryParseJsonish(line);
        const key = paramNames ? paramNames[pi] : `arg${pi}`;
        if(pv!==null) inObj[key]=pv;
        else {
          // if can't parse but looks like JSON-ish array missing quotes, keep as string
          inObj[key]=line;
        }
      }
      // Try to align with pre enriched case if same inputs already covered — skip duplicate else add without expect (or try to find expect in next line if 3-group)
      let expectVal=null, advance=paramCount;
      if(rawLines.length >= idx+paramCount+1){
        const possibleExpect = rawLines[idx+paramCount];
        // heuristic: if we have 2 params, third line often is expected answer like "[0,1]" or "true" — check if it looks like an expected boolean/array
        const pvExp = tryParseJsonish(possibleExpect);
        // If next group would start with '[' for nums again, not expected. Heuristic: for two-sum, expected is array of 2 numbers, while next nums is array length >2 usually. Ambiguous.
        // We'll treat as expected if lines length mod (paramCount+1)==0 or paramCount==1 && possible pattern differs.
        if(paramNames && paramNames.length===2 && (slug==='two-sum' || slug.includes('two'))){
          // for two-sum, third line is expected [0,1] length2 small — likely
          if(possibleExpect.startsWith('[') && possibleExpect.length<12) { expectVal=possibleExpect; advance=paramCount+1; }
        } else if(paramNames && paramNames.length===1){
          // for valid-parentheses, exampleTestcases has no expected separate – skip
        } else {
          // If we have 3 lines left pattern and we haven't yet covered with pre
          if(enriched.length===0 && paramCount===2 && rawLines.length%3===0){
            const expTry = possibleExpect;
            expectVal=expTry; advance=3;
          }
        }
      }
      let inputStr;
      try{ inputStr = JSON.stringify(inObj); }catch{ inputStr = JSON.stringify({raw:group.join('|')}); }
      let expectStr=null;
      if(expectVal!==null){
        const ev = tryParseJsonish(expectVal);
        expectStr = JSON.stringify(ev!==null? ev: expectVal);
      }
      // dedup vs enriched
      const dup = enriched.some(e=> e.input===inputStr);
      if(!dup){
        enriched.push({input:inputStr, expect:expectStr, raw: group.join(' | ') + (expectVal? ` => ${expectVal}`:'' ), __source:'exampleTestcases'});
      }
      idx+=advance;
    }
  }

  // Fallback if still empty
  if(!enriched.length){
    const raw = String(exampleTestcases||'').trim().slice(0,200);
    enriched.push({input: JSON.stringify({raw}), expect:null, raw: raw || 'see description'});
  }

  // Normalize to final shape required by custom_questions (input JSON string, expect JSON string|null, raw)
  return enriched.slice(0,12).map(c=>({input:c.input, expect:c.expect, raw:c.raw}));
}
function enrichmentEdges(slug){
  const edges=[];
  if(slug==='two-sum'){
    edges.push({input:JSON.stringify({nums:[-1,-2,-3,-4,-5], target:-8}), expect:JSON.stringify([2,4]), raw:"nums=[-1,-2,-3,-4,-5] target=-8 => [2,4]"});
    edges.push({input:JSON.stringify({nums:[0,4,3,0], target:0}), expect:JSON.stringify([0,3]), raw:"nums=[0,4,3,0] target=0 => [0,3]"});
    edges.push({input:JSON.stringify({nums:[1000000,2,3,999999], target:1000002}), expect:JSON.stringify([0,1]), raw:"large nums => [0,1]"});
  } else if(slug==='valid-parentheses'){
    edges.push({input:JSON.stringify({s:""}), expect:JSON.stringify(true), raw:"s=\"\" => true (empty valid)"});
    edges.push({input:JSON.stringify({s:"((((((("}), expect:JSON.stringify(false), raw:"s=\"((((((( \" => false"});
    edges.push({input:JSON.stringify({s:"{{{}}}"}), expect:JSON.stringify(false), raw:"s=\"{{{}}}\" => false (mismatch)"});
  } else if(slug==='merge-two-sorted-lists'){
    edges.push({input:JSON.stringify({l1:[1], l2:[]}), expect:JSON.stringify([1]), raw:"l1=[1] l2=[] => [1]"});
    edges.push({input:JSON.stringify({l1:[], l2:[]}), expect:JSON.stringify([]), raw:"both empty => []"});
    edges.push({input:JSON.stringify({l1:[5], l2:[1,2,3]}), expect:JSON.stringify([1,2,3,5]), raw:"l1=[5] l2=[1,2,3] => [1,2,3,5]"});
  } else if(slug==='lru-cache'){
    edges.push({input:JSON.stringify({operations:["LRUCache","put","get"], capacity:1, data:[[1],[1,1],[1]]}), expect:JSON.stringify([null,null,1]), raw:"LRU 1 ops put-get"});
  }
  return edges;
}
async function fetchWithTimeout(url, opts={}, timeoutMs=6000){
  const ctrl = new AbortController();
  const id = setTimeout(()=>ctrl.abort(), timeoutMs);
  try{
    const r = await fetch(url, {...opts, signal: ctrl.signal});
    clearTimeout(id);
    return r;
  }catch(e){ clearTimeout(id); throw e; }
  finally{ clearTimeout(id); }
}
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
async function fetchWithRetry(url, opts={}, retries=2, backoff=400){
  let lastErr;
  for(let i=0;i<=retries;i++){
    try{
      const r=await fetchWithTimeout(url, opts, opts.timeoutMs||6000);
      // if 429, respect Retry-After
      if(r.status===429){
        const ra = parseInt(r.headers.get('retry-after')||'2',10);
        if(i<retries) { await sleep((isNaN(ra)?2:ra)*1000 + Math.random()*300); continue; }
      }
      return r;
    }catch(e){
      lastErr=e;
      if(i<retries) await sleep(backoff*(i+1)+Math.random()*200);
    }
  }
  throw lastErr||new Error('fetch failed after retries');
}
async function leetGraphQLQuestion(slug){
  const query = `
  query questionData($titleSlug:String!){
    question(titleSlug:$titleSlug){
      questionId
      questionFrontendId
      title
      titleSlug
      content
      difficulty
      exampleTestcases
      topicTags{ name slug }
      stats
    }
  }`;
  const r = await fetchWithRetry('https://leetcode.com/graphql', {
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      'User-Agent':'Randori-Circle/1.0 (+https://randori.circle) LeetCode-proxy',
      'Referer':'https://leetcode.com/',
      'Origin':'https://leetcode.com'
    },
    body: JSON.stringify({ query, variables:{ titleSlug: slug } })
  }, 2, 600);
  if (!r.ok) throw new Error(`leetcode gql ${r.status}`);
  const j = await r.json();
  if (j.errors) throw new Error(`gql error ${JSON.stringify(j.errors).slice(0,200)}`);
  const q = j.data?.question;
  if (!q) throw new Error('question not found');
  return q;
}
async function leetEnrichAlfa(slug){
  try{
    const r = await fetchWithRetry(`https://alfa-leetcode-api.onrender.com/select?titleSlug=${encodeURIComponent(slug)}`, {
      headers:{ 'User-Agent':'Randori-Circle/1.0' }
    }, 1, 400);
    if (!r.ok) return null;
    const j = await r.json();
    // structure: { questionId, exampleTestcases, ... } varying
    return j;
  }catch{ return null; }
}
async function leetListSlugs(limit=100, skip=0){
  // try GraphQL list
  try{
    const query = `
    query problemsetQuestionList($categorySlug: String, $skip: Int, $limit: Int, $filters: {}) {
      problemsetQuestionList: questionList(categorySlug: $categorySlug, skip: $skip, limit: $limit, filters: $filters) {
        total: totalNum
        questions: data {
          titleSlug
        }
      }
    }`;
    const r = await fetchWithRetry('https://leetcode.com/graphql', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'User-Agent':'Randori-Circle/1.0' },
      body: JSON.stringify({ query, variables:{ categorySlug:"", skip, limit, filters:{} } })
    }, 2, 500);
    if (r && r.ok){
      const j = await r.json();
      const total = j.data?.problemsetQuestionList?.total ?? null;
      const qs = j.data?.problemsetQuestionList?.questions?.map(q=>q.titleSlug).filter(Boolean) ?? [];
      if (qs.length) return { slugs: qs, total };
    }
  }catch{}
  // fallback static problems/all (large ~2800) – need to slice
  try{
    const r = await fetchWithRetry('https://leetcode.com/api/problems/all/', { headers:{ 'User-Agent':'Randori-Circle/1.0' } }, 2, 500);
    if (r.ok){
      const j = await r.json();
      const pairs = j.stat_status_pairs||[];
      const slugs = pairs.map(p=>p.stat?.question__title__slug).filter(Boolean);
      const sliced = slugs.slice(skip, skip+limit);
      return { slugs: sliced, total: slugs.length };
    }
  }catch{}
  return { slugs: [], total: 0 };
}

function getEndpoint(req){
  const q = req.query?.endpoint;
  if (q) return String(q).toLowerCase();
  try{
    const u = new URL(req.url,'http://localhost');
    const ep = u.searchParams.get('endpoint');
    if (ep) return ep.toLowerCase();
    const path = u.pathname.split('/').filter(Boolean).pop();
    return (path||'').toLowerCase();
  }catch{ return (req.url||'').split('?')[0].split('/').filter(Boolean).pop()?.toLowerCase()||''; }
}

function getAuthPayload(req){
  return verifyRequestAuth(req);
}

async function getPairAccess(db, payload, weekId, pairId){
  const userId=Number(payload?.id||payload?.uid);
  if(!Number.isInteger(userId) || !Number.isInteger(weekId) || !Number.isInteger(pairId)) return {allowed:false, exists:false};
  const group=await db.execute({sql:`SELECT id,user_a_id,user_b_id,user_c_id FROM pairing_groups WHERE id=? AND week_id=? LIMIT 1`, args:[pairId,weekId]});
  if(!group.rows.length) return {allowed:false, exists:false};
  const row=group.rows[0];
  return {
    allowed:[row.user_a_id,row.user_b_id,row.user_c_id].some(memberId=>Number(memberId)===userId),
    exists:true,
  };
}

async function ensureBaseTables(db){
  try{
    await db.execute(`CREATE TABLE IF NOT EXISTS auth_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), last_login TEXT, is_available INTEGER DEFAULT 1, availability_updated_at TEXT, is_admin INTEGER DEFAULT 0, is_demo INTEGER DEFAULT 0)`);
  } catch {}
  try{
    await db.execute(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`);
  } catch {}
  try{
    await db.execute(`CREATE TABLE IF NOT EXISTS pairing_weeks (id INTEGER PRIMARY KEY AUTOINCREMENT, week_label TEXT NOT NULL, week_start TEXT NOT NULL, focus TEXT NOT NULL DEFAULT 'both', created_at TEXT DEFAULT (datetime('now')), is_demo INTEGER DEFAULT 0)`);
  } catch {}
  try{
    await db.execute(`CREATE TABLE IF NOT EXISTS pairing_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, week_id INTEGER NOT NULL, user_a_id INTEGER NOT NULL, user_b_id INTEGER NOT NULL, user_c_id INTEGER, is_ai_pair INTEGER DEFAULT 0, topic TEXT DEFAULT 'Pick together', topic_kind TEXT DEFAULT 'both', created_at TEXT DEFAULT (datetime('now')))`);
  } catch {}
}

async function ensureCustomQuestions(db){
  try{
    await db.execute(`CREATE TABLE IF NOT EXISTS custom_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      type TEXT DEFAULT 'dsa',
      difficulty TEXT DEFAULT 'Medium',
      category TEXT DEFAULT 'custom',
      description TEXT NOT NULL,
      input_format TEXT,
      constraints_text TEXT,
      examples TEXT,
      test_cases TEXT NOT NULL,
      starter_per_lang TEXT,
      author_id INTEGER,
      source TEXT DEFAULT 'custom',
      leetcode_slug TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
  }catch{}
  try{ await db.execute(`CREATE INDEX IF NOT EXISTS idx_cq_slug ON custom_questions(slug)`); }catch{}
  try{ await db.execute(`CREATE INDEX IF NOT EXISTS idx_cq_author ON custom_questions(author_id)`); }catch{}
}

async function ensureSessionRuns(db){
  try{
    await db.execute(`CREATE TABLE IF NOT EXISTS session_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      week_id INTEGER,
      pair_group_id INTEGER,
      question_id INTEGER,
      question_slug TEXT,
      language TEXT,
      code TEXT NOT NULL,
      test_cases_snapshot TEXT,
      results_json TEXT,
      passed_count INTEGER DEFAULT 0,
      total_count INTEGER DEFAULT 0,
      duration_ms INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
  }catch{}
  try{ await db.execute(`CREATE INDEX IF NOT EXISTS idx_runs_user ON session_runs(user_id, created_at DESC)`);}catch{}
  try{ await db.execute(`CREATE INDEX IF NOT EXISTS idx_runs_question ON session_runs(question_slug)`);}catch{}
  try{ await db.execute(`CREATE INDEX IF NOT EXISTS idx_runs_user_q ON session_runs(user_id, question_slug)`);}catch{}
}

async function ensureAppLogs(db){
  try{
    await db.execute(`CREATE TABLE IF NOT EXISTS app_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL,
      source TEXT NOT NULL,
      event TEXT,
      message TEXT NOT NULL,
      meta_json TEXT,
      user_id INTEGER,
      route TEXT,
      ua TEXT,
      ip TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
  }catch(e){ /* ignore */ }
  try{ await db.execute(`CREATE INDEX IF NOT EXISTS idx_logs_level_created ON app_logs(level, created_at DESC)`);}catch{}
  try{ await db.execute(`CREATE INDEX IF NOT EXISTS idx_logs_event_created ON app_logs(event, created_at DESC)`);}catch{}
  try{ await db.execute(`CREATE INDEX IF NOT EXISTS idx_logs_source_created ON app_logs(source, created_at DESC)`);}catch{}
  try{ await db.execute(`CREATE INDEX IF NOT EXISTS idx_logs_created ON app_logs(created_at DESC)`);}catch{}
}

// In-memory rate limit map for client logs per IP
const __logRateMap = new Map(); // ip -> [timestamps]
const __activeExecutionsByUser = new Set();
const EXECUTIONS_PER_MINUTE = 10;
function isLogRateLimited(ip){
  const now=Date.now();
  const arr = __logRateMap.get(ip) || [];
  const fresh = arr.filter(t=> now - t < 60000);
  if(fresh.length >= 60){ __logRateMap.set(ip, fresh); return true; }
  fresh.push(now);
  __logRateMap.set(ip, fresh);
  if(__logRateMap.size>500){ // prune
    for(const [k,v] of __logRateMap.entries()){ if(v.length && now - v[0] > 120000) __logRateMap.delete(k); if(__logRateMap.size<400) break; }
  }
  return false;
}


async function handleHealth(req,res){
  // Public health is deliberately aggregate-only; detailed logs are admin-only.
  try{
    const db=getClient();
    try{ await ensureAppLogs(db); }catch{}
    let errors_last_hour=0, warns_last_hour=0, infos_last_hour=0, success_last_hour=0;
    try{
      const rs1=await db.execute(`SELECT level, COUNT(*) as c FROM app_logs WHERE datetime(created_at) >= datetime('now','-1 hour') GROUP BY level`);
      for(const r of rs1.rows){
        const lvl=String(r.level||'').toLowerCase();
        const c=Number(r.c||0);
        if(lvl==='error') errors_last_hour=c;
        else if(lvl==='warn') warns_last_hour=c;
        else if(lvl==='info') infos_last_hour=c;
        else if(lvl==='success') success_last_hour=c;
      }
    }catch{}
    // also counts last 10 events of interest
    let monaco_fails=0, piston_fails=0;
    try{
      const rs3=await db.execute(`SELECT event, COUNT(*) as c FROM app_logs WHERE datetime(created_at) >= datetime('now','-6 hours') AND event IN ('monaco_load_fail','execute_fail','piston_fail','api_fail') GROUP BY event`);
      for(const r of rs3.rows){
        if(r.event==='monaco_load_fail') monaco_fails=Number(r.c||0);
        if(r.event==='execute_fail' || r.event==='piston_fail') piston_fails+=Number(r.c||0);
      }
    }catch{}
    const spike = errors_last_hour>5;
    return res.json({ok:true, ts:new Date().toISOString(), errors_last_hour, warns_last_hour, infos_last_hour, success_last_hour, monaco_fails_6h:monaco_fails, piston_fails_6h:piston_fails, spike, warning: spike? 'error spike detected — >5 errors last hour': null, last_5_errors:[]});
  }catch(e){
    return res.status(503).json({ok:false, error:'health unavailable'});
  }
}


async function logServer(level, event, message, meta, reqCtx){
  try{
    const db=getClient();
    if(!reqCtx?.skipEnsure) await ensureAppLogs(db);
    const allowed=['info','warn','error','success','debug'];
    let lvl=String(level||'info').toLowerCase();
    if(!allowed.includes(lvl)) lvl='info';
    const src = (reqCtx && reqCtx.source) ? String(reqCtx.source).slice(0,20) : 'server';
    const ev = event ? String(event).slice(0,80) : null;
    let msg = String(message||'').slice(0,2000);
    let metaStr=null;
    if(meta!=null){
      try{ metaStr = typeof meta==='string' ? meta.slice(0,8000) : JSON.stringify(meta).slice(0,8000); }catch{ metaStr=String(meta).slice(0,8000); }
    }
    let user_id=null;
    try{
      if(reqCtx){
        if(reqCtx.user_id) user_id=reqCtx.user_id;
        else if(reqCtx.payload && (reqCtx.payload.id||reqCtx.payload.uid)) user_id=reqCtx.payload.id||reqCtx.payload.uid;
        else if(reqCtx.userId) user_id=reqCtx.userId;
      }
    }catch{}
    let route=null, ua=null, ip=null;
    try{
      if(reqCtx && reqCtx.route) route=String(reqCtx.route).slice(0,300);
      else if(reqCtx && reqCtx.headers && reqCtx.url) route=String(reqCtx.url).slice(0,300);
      else if(reqCtx && reqCtx.req && reqCtx.req.url) route=String(reqCtx.req.url).slice(0,300);
      if(reqCtx && reqCtx.ua) ua=String(reqCtx.ua).slice(0,300);
      else if(reqCtx && reqCtx.headers) ua = (reqCtx.headers['user-agent']||reqCtx.headers['User-Agent']||'').toString().slice(0,300);
      else if(reqCtx && reqCtx.req && reqCtx.req.headers) ua = (reqCtx.req.headers['user-agent']||'').toString().slice(0,300);
      if(reqCtx && reqCtx.ip) ip=String(reqCtx.ip).slice(0,80);
      else if(reqCtx && reqCtx.headers) ip = (reqCtx.headers['x-forwarded-for']||reqCtx.headers['x-real-ip']||'').toString().split(',')[0].trim().slice(0,80);
      else if(reqCtx && reqCtx.req && reqCtx.req.headers) ip = (reqCtx.req.headers['x-forwarded-for']||'').toString().split(',')[0].trim().slice(0,80);
    }catch{}
    await db.execute({sql:`INSERT INTO app_logs (level, source, event, message, meta_json, user_id, route, ua, ip, created_at) VALUES (?,?,?,?,?,?,?,?,?, datetime('now'))`, args:[lvl, src, ev, msg, metaStr, user_id, route, ua, ip]});
    // Forward to Sentry server if error/warn
    try{
      if((lvl==='error' || lvl==='warn') && isSentryConfigured() && !reqCtx?.skipSentry){
        const tags={event: ev||'server', level:lvl, source:src};
        if(lvl==='error'){
          if(meta && meta.stack){
            const e=new Error(msg.slice(0,500));
            e.name=String(ev||'ServerError');
            captureSentryException(e, {tags, extra: {meta: metaStr?.slice(0,2000), route, user_id}});
          }else{
            captureSentryMessage(msg, {level:'error', tags, extra:{meta: metaStr?.slice(0,2000), route}});
          }
        }else if(lvl==='warn'){
          captureSentryMessage(msg, {level:'warning', tags, extra:{meta: metaStr?.slice(0,1500)}});
        }
      }
    }catch(e){ try{ console.warn('[sentry server forward fail]', e && e.message);}catch{} }
  }catch(e){
    // never throw — log to console as fallback
    try{ console.warn('[logServer fail]', e && e.message); }catch{}
  }
}

async function ensureProfileMigrations(db){
  const alters=[
    `ALTER TABLE auth_accounts ADD COLUMN is_available INTEGER DEFAULT 1`,
    `ALTER TABLE auth_accounts ADD COLUMN availability_updated_at TEXT`,
    `ALTER TABLE auth_accounts ADD COLUMN is_admin INTEGER DEFAULT 0`,
    `ALTER TABLE auth_accounts ADD COLUMN is_demo INTEGER DEFAULT 0`,
    `ALTER TABLE auth_accounts ADD COLUMN bio TEXT`,
    `ALTER TABLE auth_accounts ADD COLUMN tz TEXT`,
    `ALTER TABLE auth_accounts ADD COLUMN interview_focus TEXT DEFAULT 'both'`,
    `ALTER TABLE auth_accounts ADD COLUMN leetcode_handle TEXT`,
    `ALTER TABLE pairing_weeks ADD COLUMN is_demo INTEGER DEFAULT 0`,
  ];
  for(const sql of alters){ try{ await db.execute(sql); }catch{} }
  // new tables
  try{
    await db.execute(`CREATE TABLE IF NOT EXISTS pair_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, week_id INTEGER NOT NULL, pair_group_id INTEGER NOT NULL, sender_id INTEGER NOT NULL, message TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`);
  }catch{}
  try{
    await db.execute(`CREATE TABLE IF NOT EXISTS pair_schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, week_id INTEGER NOT NULL, pair_group_id INTEGER NOT NULL, proposed_times TEXT, agreed_time TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), UNIQUE(week_id,pair_group_id))`);
  }catch{}
  try{ await db.execute(`CREATE INDEX IF NOT EXISTS idx_pair_messages_pair ON pair_messages(pair_group_id, created_at)`);}catch{}
  try{ await db.execute(`CREATE INDEX IF NOT EXISTS idx_pair_sched_pair ON pair_schedules(pair_group_id)`);}catch{}
  await ensureCustomQuestions(db);
  await ensureSessionRuns(db);
  try{ await ensureAppLogs(db); }catch{}
}


async function handleLogs(req,res){
  // POST: client logs ingest, GET: admin fetch
  if(req.method==='POST'){
    const payload = getAuthPayload(req);
    if(!payload) return res.status(401).json({error:'authentication required'});
    const db = getClient();
    try{ await ensureAppLogs(db); }catch{}
    // rate limit by IP
    let ip='';
    try{ ip=(req.headers['x-forwarded-for']||req.headers['x-real-ip']||'').toString().split(',')[0].trim(); if(!ip && req.headers['x-forwarded-for']){ ip=req.headers['x-forwarded-for']; } }catch{}
    if(ip && isLogRateLimited(ip)){
      return res.status(429).json({error:'rate limited — too many logs', retry_after:'60s'});
    }
    const userId = payload.id||payload.uid||null;
    const body = req.body || {};
    // support batch array
    let batch = [];
    if(Array.isArray(body)) batch = body;
    else if(Array.isArray(body.logs)) batch = body.logs;
    else batch = [body];
    const allowedLevels = new Set(['info','warn','error','success','debug']);
    let inserted=0;
    for(const entry of batch.slice(0,20)){ // cap 20 per request
      let lvl = String(entry.level||'info').toLowerCase();
      if(!allowedLevels.has(lvl)) lvl='info';
      const requestedSource = String(entry.source||'client').slice(0,20);
      // The runner namespace is a server-side coordination boundary. Never let
      // browser telemetry create rows that can be mistaken for leases or quota
      // records, even when an authenticated client supplies those names.
      let src = requestedSource==='runner' ? 'client' : requestedSource;
      let ev = entry.event ? String(entry.event).slice(0,80) : null;
      if(ev && (ev==='execute_attempt' || ev.startsWith('execute_lease_'))){
        ev=`client_${ev}`.slice(0,80);
      }
      let msg = String(entry.message||'').slice(0,2000);
      if(!msg) continue;
      let metaStr=null;
      try{
        if(entry.meta!=null) metaStr = typeof entry.meta==='string' ? String(entry.meta).slice(0,8000) : JSON.stringify(entry.meta).slice(0,8000);
        else if(entry.meta_json) metaStr = String(entry.meta_json).slice(0,8000);
      }catch{}
      let route = entry.route ? String(entry.route).slice(0,300) : null;
      if(!route){
        try{ route = (req.url||'').toString().slice(0,300); }catch{}
      }
      let ua = entry.ua ? String(entry.ua).slice(0,300) : (req.headers['user-agent']||'').toString().slice(0,300);
      let entryIp = ip || (req.headers['x-forwarded-for']||'').toString().split(',')[0].trim().slice(0,80);
      try{
        await db.execute({sql:`INSERT INTO app_logs (level, source, event, message, meta_json, user_id, route, ua, ip, created_at) VALUES (?,?,?,?,?,?,?,?,?, datetime('now'))`, args:[lvl, src, ev, msg, metaStr, userId, route, ua, entryIp]});
        inserted++;
      }catch(e){ /* ignore per entry */ }
      // fire console for visibility in Vercel logs
      try{ if(lvl==='error') console.error(`[client][${ev}] ${msg}`); else if(lvl==='warn') console.warn(`[client][${ev}] ${msg}`); else console.log(`[client][${lvl}][${ev}] ${msg}`);}catch{}
    }
    return res.json({ok:true, inserted});
  }
  if(req.method==='GET'){
    // admin only
    const adminCtx = await requireAdminDT(req,res);
    if(!adminCtx) return;
    const db=adminCtx.db;
    try{ await ensureAppLogs(db); }catch{}
    const url = new URL(req.url,'http://localhost');
    const level = (req.query?.level || url.searchParams.get('level') || '').toString().toLowerCase().trim();
    const event = (req.query?.event || url.searchParams.get('event') || '').toString().trim().slice(0,80);
    const source = (req.query?.source || url.searchParams.get('source') || '').toString().trim().slice(0,20);
    const limitRaw = parseInt(String(req.query?.limit || url.searchParams.get('limit') || '100'),10);
    const limit = Math.min(200, Math.max(1, isNaN(limitRaw)?100:limitRaw));
    const sinceRaw = (req.query?.since || url.searchParams.get('since') || '').toString().trim();
    let where=[]; let args=[];
    if(level && ['info','warn','error','success','debug'].includes(level)){ where.push('level=?'); args.push(level); }
    if(event){ where.push('event=?'); args.push(event); }
    if(source){ where.push('source=?'); args.push(source); }
    if(sinceRaw){
      // allow ISO or id > ?
      const idSince = parseInt(sinceRaw,10);
      if(!isNaN(idSince) && String(idSince)===sinceRaw){ where.push('id>?'); args.push(idSince); }
      else { where.push('created_at>=?'); args.push(sinceRaw); }
    }
    let sql = `SELECT id, level, source, event, message, meta_json, user_id, route, ua, ip, created_at FROM app_logs`;
    if(where.length) sql += ` WHERE ` + where.join(' AND ');
    sql += ` ORDER BY id DESC LIMIT ?`;
    args.push(limit);
    try{
      const rs = await db.execute({sql, args});
      const logs = rs.rows.map(r=>{
        let meta=null;
        try{ meta = r.meta_json ? JSON.parse(r.meta_json) : null; }catch{ meta = r.meta_json; }
        return { id:r.id, level:r.level, source:r.source, event:r.event, message:r.message, meta, meta_json:r.meta_json, user_id:r.user_id, route:r.route, ua:r.ua, ip:r.ip, created_at:r.created_at };
      });
      return res.json({ok:true, logs, count:logs.length});
    }catch(e){ return res.status(500).json({error:'logs fetch failed', detail:String(e.message||e).slice(0,300)}); }
  }
  return res.status(405).json({error:'GET or POST only for logs'});
}

async function handleCircle(req,res){
  if (req.method !== 'GET') return res.status(405).json({ error:'GET only' });
  const viewer=getAuthPayload(req);
  if(!viewer) return res.status(401).json({error:'authentication required'});
  const db = getClient();
  await ensureBaseTables(db);
  await ensureProfileMigrations(db);
  const includeDemo = (req.query?.include_demo === '1' || req.query?.includeDemo === '1' || req.query?.demo === '1');
  try{
    let sql = includeDemo
      ? `SELECT id, display_name, color, email, created_at, is_available, availability_updated_at, is_admin, is_demo, bio, tz, interview_focus, leetcode_handle FROM auth_accounts ORDER BY id`
      : `SELECT id, display_name, color, email, created_at, is_available, availability_updated_at, is_admin, is_demo, bio, tz, interview_focus, leetcode_handle FROM auth_accounts WHERE COALESCE(is_demo,0)=0 ORDER BY id`;
    const rs = await db.execute(sql);
    if (rs.rows.length){
      const circle = rs.rows.map(r=>{
        const item={ id:r.id, display_name:r.display_name, name:r.display_name, color:r.color, is_demo:!!r.is_demo, source:'auth' };
        item.is_available=r.is_available===null||r.is_available===undefined?true:!!r.is_available;
        item.isAvailable=item.is_available;
        item.bio=r.bio||null;
        item.tz=r.tz||null;
        item.interview_focus=r.interview_focus||'both';
        item.leetcode_handle=r.leetcode_handle||null;
        return item;
      });
      return res.json({ ok:true, circle, count:circle.length, source:'auth_accounts', filtered_demo: !includeDemo });
    }
  }catch{}
  try{
    const rs2 = await db.execute(`SELECT id, name, color, created_at FROM users ORDER BY id`);
    const circle = rs2.rows.map(r=>({ id:r.id, display_name:r.name, name:r.name, color:r.color, created_at:r.created_at, is_available:true, isAvailable:true, is_admin:false, is_demo:false, source:'users' }));
    return res.json({ ok:true, circle, count:circle.length, source:'users' });
  }catch(e){ try{ await logServer('error','circle_fetch_fail', `circle db error ${String(e.message||e).slice(0,150)}`, {err:String(e.message||e).slice(0,500)}, {req, source:'server'}); }catch{} return res.status(500).json({ error:'db error', detail:String(e.message||e).slice(0,200)}); }
}

async function handleWeeks(req,res){
  if (req.method !== 'GET') return res.status(405).json({ error:'GET only' });
  if (!getAuthPayload(req)) return res.status(401).json({ error:'authentication required' });
  const db = getClient();
  await ensureBaseTables(db);
  await ensureProfileMigrations(db);
  const includeDemo = (req.query?.include_demo === '1' || req.query?.includeDemo === '1' || req.query?.demo === '1' || req.query?.include_demo === 'true');
  try{
    let sql = includeDemo
      ? `SELECT id, week_label, week_start, focus, created_at, is_demo FROM pairing_weeks ORDER BY id DESC LIMIT 20`
      : `SELECT id, week_label, week_start, focus, created_at, is_demo FROM pairing_weeks WHERE COALESCE(is_demo,0)=0 ORDER BY id DESC LIMIT 20`;
    const weeksRs = await db.execute(sql);
    if (!weeksRs.rows.length) return res.json({ ok:true, weeks:[], filtered_demo: !includeDemo });
    const weekIds = weeksRs.rows.map(w=>w.id);
    const placeholders = weekIds.map(()=>'?').join(',');
    const groupsRs = await db.execute({ sql:`SELECT id as pg_id, week_id, user_a_id, user_b_id, user_c_id, is_ai_pair, topic, topic_kind, created_at FROM pairing_groups WHERE week_id IN (${placeholders}) ORDER BY week_id DESC, id ASC`, args:weekIds });
    const allIds = new Set(); groupsRs.rows.forEach(r=>{ allIds.add(r.user_a_id); allIds.add(r.user_b_id); if(r.user_c_id!=null) allIds.add(r.user_c_id); });
    let idTo={};
    if (allIds.size){
      const ids=[...allIds]; const ph=ids.map(()=>'?').join(',');
      try{
        const authRows = await db.execute({ sql:`SELECT id, display_name as name, color, tz, interview_focus FROM auth_accounts WHERE id IN (${ph})`, args:ids });
        authRows.rows.forEach(r=>{ idTo[r.id]={name:r.name,color:r.color,tz:r.tz,focus:r.interview_focus,source:'auth'}; });
        const missing = ids.filter(i=>!idTo[i]);
        if (missing.length){
          const ph2 = missing.map(()=>'?').join(',');
          const uRows = await db.execute({ sql:`SELECT id, name, color FROM users WHERE id IN (${ph2})`, args:missing });
          uRows.rows.forEach(r=>{ idTo[r.id]={name:r.name,color:r.color,source:'users'}; });
        }
      }catch{}
    }
    const weeks = weeksRs.rows.map(w=>{
      const pairs = groupsRs.rows.filter(g=>g.week_id===w.id).map(g=>{
        const a = idTo[g.user_a_id]||{name:`User ${g.user_a_id}`, color:'#999'};
        const b = g.is_ai_pair ? {name:'AI partner', color:'var(--accent)'} : (idTo[g.user_b_id]||{name:`User ${g.user_b_id}`, color:'#999'});
        const c = g.user_c_id==null ? null : (idTo[g.user_c_id]||{name:`User ${g.user_c_id}`, color:'#999'});
        const members=[
          {id:g.user_a_id,name:a.name,color:a.color},
          {id:g.user_b_id,name:b.name,color:b.color,is_ai:!!g.is_ai_pair},
          ...(c?[{id:g.user_c_id,name:c.name,color:c.color}]:[]),
        ];
        return { pg_id:g.pg_id, a_id:g.user_a_id, b_id:g.user_b_id, c_id:g.user_c_id??null, a_name:a.name, b_name:b.name, c_name:c?.name??null, a_color:a.color, b_color:b.color, c_color:c?.color??null, members, is_ai:!!g.is_ai_pair, is_demo_week: !!w.is_demo, topic:g.topic, topic_kind:g.topic_kind, created_at:g.created_at };
      });
      return { id:w.id, week_label:w.week_label, week_start:w.week_start, focus:w.focus, created_at:w.created_at, is_demo:!!w.is_demo, pairs };
    });
    return res.json({ ok:true, weeks, filtered_demo: !includeDemo });
  }catch(e){ try{ await logServer('error','weeks_fetch_fail', `weeks query fail ${String(e.message||e).slice(0,120)}`, {err:String(e.message||e).slice(0,400)}, {req, source:'server'}); }catch{} return res.status(500).json({ ok:false, error:'weeks query failed', detail:String(e.message||e).slice(0,300)}); }
}

async function handleHistory(req,res){
  if (req.method !== 'GET') return res.status(405).json({ error:'GET only' });
  const payload = getAuthPayload(req);
  if (!payload) return res.status(401).json({ error:'missing Bearer token' });
  const db = getClient();
  await ensureProfileMigrations(db);
  const userId = payload.id || payload.uid;
  const groups = await db.execute({ sql:`
    SELECT pg.id as pg_id, pg.week_id, pg.user_a_id, pg.user_b_id, pg.user_c_id, pg.is_ai_pair, pg.topic, pg.topic_kind,
           pw.week_label, pw.week_start
    FROM pairing_groups pg
    JOIN pairing_weeks pw ON pw.id = pg.week_id
    WHERE pg.user_a_id = ? OR pg.user_b_id = ? OR pg.user_c_id = ?
    ORDER BY pw.week_start DESC, pg.id DESC
  `, args:[userId,userId,userId] });
  const allIds = new Set(); groups.rows.forEach(r=>{ allIds.add(r.user_a_id); allIds.add(r.user_b_id); if(r.user_c_id!=null) allIds.add(r.user_c_id); });
  let idToName={};
  if (allIds.size){
    const ids=[...allIds]; const placeholders=ids.map(()=>'?').join(',');
    try{ const authRows=await db.execute({ sql:`SELECT id, display_name as name FROM auth_accounts WHERE id IN (${placeholders})`, args:ids }); authRows.rows.forEach(r=>{ idToName[r.id]=r.name; }); const missing=ids.filter(i=>!idToName[i]); if(missing.length){ const ph2=missing.map(()=>'?').join(','); const uRows=await db.execute({ sql:`SELECT id, name FROM users WHERE id IN (${ph2})`, args:missing }); uRows.rows.forEach(r=>{ idToName[r.id]=r.name; }); } }catch{}
  }
  const enriched = groups.rows.map(r=>{
    const isA = Number(r.user_a_id)===Number(userId);
    const participantIds=[r.user_a_id,r.user_b_id,r.user_c_id]
      .filter(id=>id!=null && Number(id)!==Number(userId));
    const partnerIds=r.is_ai_pair ? [] : participantIds;
    const partnerNames=r.is_ai_pair
      ? ['AI partner']
      : partnerIds.map(id=>idToName[id]||`User ${id}`);
    return { pg_id:r.pg_id, week_id:r.week_id, week_label:r.week_label, week_start:r.week_start, is_ai:!!r.is_ai_pair, topic:r.topic, topic_kind:r.topic_kind, partner_id:partnerIds[0]??null, partner_name:partnerNames.join(' & '), partner_ids:partnerIds, partner_names:partnerNames, you_are_a:isA };
  });
  const partnerCounts={}; enriched.forEach(e=>{ if(!e.is_ai) e.partner_names.forEach(name=>{ partnerCounts[name]=(partnerCounts[name]||0)+1; }); });
  return res.json({ ok:true, user:{ id:payload.id, name:payload.name }, history:enriched, partner_counts:partnerCounts, total:enriched.length });
}

async function handleInit(req,res){
  if (req.method!=='POST') return res.status(405).json({ error:'POST only' });
  const adminCtx=await requireAdminDT(req,res);
  if(!adminCtx) return;
  const db = adminCtx.db;
  await db.batch([
    `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS auth_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), last_login TEXT, is_available INTEGER DEFAULT 1, availability_updated_at TEXT, is_admin INTEGER DEFAULT 0, is_demo INTEGER DEFAULT 0, bio TEXT, tz TEXT, interview_focus TEXT DEFAULT 'both', leetcode_handle TEXT)`,
    `CREATE TABLE IF NOT EXISTS pairing_weeks (id INTEGER PRIMARY KEY AUTOINCREMENT, week_label TEXT NOT NULL, week_start TEXT NOT NULL, focus TEXT NOT NULL DEFAULT 'both', created_at TEXT DEFAULT (datetime('now')), is_demo INTEGER DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS pairing_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, week_id INTEGER NOT NULL REFERENCES pairing_weeks(id) ON DELETE CASCADE, user_a_id INTEGER NOT NULL, user_b_id INTEGER NOT NULL, user_c_id INTEGER, is_ai_pair INTEGER DEFAULT 0, topic TEXT DEFAULT 'Pick together', topic_kind TEXT DEFAULT 'both', created_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS questions (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL, type TEXT NOT NULL, difficulty TEXT NOT NULL, category TEXT NOT NULL, description TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS video_signals (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS ai_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT, pair_label TEXT, transcript TEXT, code_snapshots TEXT, interviewer_questions TEXT, started_at TEXT DEFAULT (datetime('now')), ended_at TEXT, duration_sec INTEGER, cost_cents INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), created_by INTEGER)`,
    `CREATE TABLE IF NOT EXISTS ai_feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE, role TEXT DEFAULT 'both', feedback_json TEXT NOT NULL, evidence TEXT, model_used TEXT, reason_for_pick TEXT, estimated_cost_cents INTEGER, confidence REAL DEFAULT 0.85, created_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS ai_usage (date TEXT PRIMARY KEY, calls INTEGER DEFAULT 0, tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0, updated_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS pair_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, week_id INTEGER NOT NULL, pair_group_id INTEGER NOT NULL, sender_id INTEGER NOT NULL, message TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS pair_schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, week_id INTEGER NOT NULL, pair_group_id INTEGER NOT NULL, proposed_times TEXT, agreed_time TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), UNIQUE(week_id,pair_group_id))`,
    `CREATE TABLE IF NOT EXISTS custom_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      type TEXT DEFAULT 'dsa',
      difficulty TEXT DEFAULT 'Medium',
      category TEXT DEFAULT 'custom',
      description TEXT NOT NULL,
      input_format TEXT,
      constraints_text TEXT,
      examples TEXT,
      test_cases TEXT NOT NULL,
      starter_per_lang TEXT,
      author_id INTEGER,
      source TEXT DEFAULT 'custom',
      leetcode_slug TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS app_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL,
      source TEXT NOT NULL,
      event TEXT,
      message TEXT NOT NULL,
      meta_json TEXT,
      user_id INTEGER,
      route TEXT,
      ua TEXT,
      ip TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS session_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      week_id INTEGER,
      pair_group_id INTEGER,
      question_id INTEGER,
      question_slug TEXT,
      language TEXT,
      code TEXT NOT NULL,
      test_cases_snapshot TEXT,
      results_json TEXT,
      passed_count INTEGER DEFAULT 0,
      total_count INTEGER DEFAULT 0,
      duration_ms INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    )`
  ],"write");
  const migrations=[`ALTER TABLE auth_accounts ADD COLUMN is_available INTEGER DEFAULT 1`,`ALTER TABLE auth_accounts ADD COLUMN availability_updated_at TEXT`,`ALTER TABLE auth_accounts ADD COLUMN is_admin INTEGER DEFAULT 0`,`ALTER TABLE auth_accounts ADD COLUMN is_demo INTEGER DEFAULT 0`,`ALTER TABLE auth_accounts ADD COLUMN bio TEXT`,`ALTER TABLE auth_accounts ADD COLUMN tz TEXT`,`ALTER TABLE auth_accounts ADD COLUMN interview_focus TEXT DEFAULT 'both'`,`ALTER TABLE auth_accounts ADD COLUMN leetcode_handle TEXT`,`ALTER TABLE pairing_weeks ADD COLUMN is_demo INTEGER DEFAULT 0`];
  for(const sql of migrations){ try{ await db.execute(sql);}catch(_){} }
  try{ await db.execute(`CREATE INDEX IF NOT EXISTS idx_video_signals_room ON video_signals(room_id, created_at)`);}catch{}
  try{ await db.execute(`CREATE INDEX IF NOT EXISTS idx_video_signals_room_id ON video_signals(room_id, id)`);}catch{}
  try{ await db.execute(`CREATE INDEX IF NOT EXISTS idx_pair_messages_pair ON pair_messages(pair_group_id, created_at)`);}catch{}
  try{ await db.execute(`CREATE INDEX IF NOT EXISTS idx_pair_sched_pair ON pair_schedules(pair_group_id)`);}catch{}
  try{
    // This one-time cleanup is intentionally admin-triggered: it can delete legacy
    // duplicates and must never run as a side effect of an ordinary API request.
    await db.execute(`DELETE FROM pair_schedules WHERE id NOT IN (SELECT MAX(id) FROM pair_schedules GROUP BY week_id,pair_group_id)`);
    await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS uq_pair_schedules_week_pair ON pair_schedules(week_id,pair_group_id)`);
  }catch(e){
    return res.status(500).json({
      ok:false,
      error:'pair schedule uniqueness migration failed',
      detail:String(e.message||e).slice(0,300),
    });
  }
  try{ await db.execute(`CREATE INDEX IF NOT EXISTS idx_cq_slug ON custom_questions(slug)`);}catch{}
  try{ await db.execute(`CREATE INDEX IF NOT EXISTS idx_cq_author ON custom_questions(author_id)`);}catch{}
  try{ await db.execute(`CREATE INDEX IF NOT EXISTS idx_runs_user ON session_runs(user_id, created_at DESC)`);}catch{}
  try{ await db.execute(`CREATE INDEX IF NOT EXISTS idx_runs_question ON session_runs(question_slug)`);}catch{}
  await maybeSeedFromStatic(db);
  return res.json({ ok:true, message:"Tables ready (incl custom_questions + profile + pair_messages + pair_schedules + session_runs)" });
}

// ----- NEW ENDPOINTS: profile, my-pair, schedule, messages, questions -----

async function handleProfile(req,res){
  const payload = getAuthPayload(req);
  if (!payload) return res.status(401).json({ error:'missing Bearer token' });
  const db = getClient();
  await ensureBaseTables(db);
  await ensureProfileMigrations(db);
  const userId = payload.id || payload.uid;
  if (!userId) return res.status(401).json({ error:'invalid token payload' });
  if (req.method === 'GET'){
    const rs = await db.execute({ sql:`SELECT id,email,display_name,color,created_at,last_login,is_available,availability_updated_at,is_admin,is_demo,bio,tz,interview_focus,leetcode_handle FROM auth_accounts WHERE id=?`, args:[userId] });
    if (!rs.rows.length) return res.status(404).json({ error:'user not found' });
    const r = rs.rows[0];
    return res.json({ ok:true, user:{ id:r.id, email:r.email, name:r.display_name, display_name:r.display_name, color:r.color, created_at:r.created_at, last_login:r.last_login, is_available: r.is_available===null?true:!!r.is_available, isAvailable: r.is_available===null?true:!!r.is_available, availability_updated_at:r.availability_updated_at, is_admin:!!r.is_admin, is_demo:!!r.is_demo, bio:r.bio||'', tz:r.tz||'', interview_focus:r.interview_focus||'both', leetcode_handle:r.leetcode_handle||'' }});
  }
  if (req.method === 'POST'){
    const body = req.body||{};
    const allowed = ['display_name','name','color','bio','tz','interview_focus','leetcode_handle','is_available'];
    const updates={};
    if (body.display_name!==undefined) updates.display_name = String(body.display_name).trim().slice(0,32);
    if (body.name!==undefined && updates.display_name===undefined) updates.display_name = String(body.name).trim().slice(0,32);
    if (body.color!==undefined) updates.color = String(body.color).trim().slice(0,16);
    if (body.bio!==undefined) updates.bio = String(body.bio).trim().slice(0,500);
    if (body.tz!==undefined) updates.tz = String(body.tz).trim().slice(0,64);
    if (body.interview_focus!==undefined){
      const v = String(body.interview_focus).toLowerCase();
      if (['dsa','system','both'].includes(v)||['dsa','system_design','both'].includes(v)) updates.interview_focus = v.includes('system')?'system': (v==='dsa'?'dsa':'both');
      else updates.interview_focus = 'both';
    }
    if (body.leetcode_handle!==undefined) updates.leetcode_handle = String(body.leetcode_handle).trim().slice(0,64);
    if (body.is_available!==undefined){
      updates.is_available = body.is_available ? 1 : 0;
      updates.availability_updated_at = new Date().toISOString();
    }
    if (Object.keys(updates).length===0) return res.status(400).json({ error:'no fields to update', allowed });
    const cols = Object.keys(updates);
    const setSql = cols.map(c=>`${c}=?`).join(', ');
    const args = cols.map(c=>updates[c]).concat([userId]);
    try{
      await db.execute({ sql:`UPDATE auth_accounts SET ${setSql} WHERE id=?`, args });
    }catch(e){ return res.status(500).json({ error:'update failed', detail:String(e.message||e).slice(0,200)}); }
    const rs = await db.execute({ sql:`SELECT id,email,display_name,color,is_available,availability_updated_at,is_admin,bio,tz,interview_focus,leetcode_handle FROM auth_accounts WHERE id=?`, args:[userId] });
    const r = rs.rows[0];
    return res.json({ ok:true, user:{ id:r.id, email:r.email, name:r.display_name, display_name:r.display_name, color:r.color, is_available:!!r.is_available, availability_updated_at:r.availability_updated_at, is_admin:!!r.is_admin, bio:r.bio||'', tz:r.tz||'', interview_focus:r.interview_focus||'both', leetcode_handle:r.leetcode_handle||'' }});
  }
  return res.status(405).json({ error:'GET or POST only' });
}

async function handleMyPair(req,res){
  if (req.method !== 'GET') return res.status(405).json({ error:'GET only' });
  const payload = getAuthPayload(req);
  if (!payload) return res.status(401).json({ error:'missing Bearer token' });
  const db = getClient();
  await ensureBaseTables(db);
  await ensureProfileMigrations(db);
  const userId = payload.id || payload.uid;
  let weekId=null, weekRow=null;
  try{
    const w = await db.execute(`SELECT id, week_label, week_start, focus FROM pairing_weeks WHERE COALESCE(is_demo,0)=0 ORDER BY id DESC LIMIT 1`);
    if (w.rows.length){ weekRow=w.rows[0]; weekId=w.rows[0].id; }
  }catch{}
  if (!weekId) return res.json({ ok:true, paired:false, reason:'no_week_yet', message:'No pairs yet — shuffles Sunday 08:00 BST' });
  let grp=null;
  try{
    const g = await db.execute({ sql:`SELECT id as pg_id, week_id, user_a_id, user_b_id, user_c_id, is_ai_pair, topic, topic_kind FROM pairing_groups WHERE week_id=? AND (user_a_id=? OR user_b_id=? OR user_c_id=?) LIMIT 1`, args:[weekId, userId, userId, userId] });
    if (g.rows.length) grp=g.rows[0];
  }catch{}
  if (!grp) return res.json({ ok:true, paired:false, week_id:weekId, week:weekRow||null, reason:'not_paired_this_week', message:'You were not paired in the latest shuffle — you may have been marked unavailable.' });
  const isAI = !!grp.is_ai_pair;
  let partner=null, partners=[];
  if (isAI){
    partner={ id:null, name:'AI partner', display_name:'AI partner', color:'#c8f6a0', is_ai:true, is_ai_partner:true };
    partners=[partner];
  }else{
    const partnerIds=[grp.user_a_id,grp.user_b_id,grp.user_c_id]
      .filter(id=>id!=null && Number(id)!==Number(userId));
    try{
      const placeholders=partnerIds.map(()=>'?').join(',');
      const pr = await db.execute({ sql:`SELECT id, display_name, color, bio, tz, interview_focus, leetcode_handle FROM auth_accounts WHERE id IN (${placeholders})`, args:partnerIds });
      const byId=new Map(pr.rows.map(r=>[Number(r.id),r]));
      partners=partnerIds.map(id=>{
        const r=byId.get(Number(id));
        return r
          ? { id:r.id, name:r.display_name, display_name:r.display_name, color:r.color, bio:r.bio||'', tz:r.tz||'', interview_focus:r.interview_focus||'both', leetcode_handle:r.leetcode_handle||'', is_ai:false }
          : { id, name:`User ${id}`, display_name:`User ${id}`, color:'#9aa0a6', is_ai:false };
      });
    }catch{
      partners=partnerIds.map(id=>({ id, name:`User ${id}`, display_name:`User ${id}`, color:'#9aa0a6', is_ai:false }));
    }
    partner=partners[0]||null;
  }
  let schedule=null;
  try{
    const s = await db.execute({ sql:`SELECT id, week_id, pair_group_id, proposed_times, agreed_time, updated_at FROM pair_schedules WHERE week_id=? AND pair_group_id=? LIMIT 1`, args:[weekId, grp.pg_id] });
    if (s.rows.length){
      schedule={ id:s.rows[0].id, week_id:s.rows[0].week_id, pair_group_id:s.rows[0].pair_group_id, proposed_times: s.rows[0].proposed_times ? JSON.parse(s.rows[0].proposed_times) : [], agreed_time: s.rows[0].agreed_time||null, updated_at:s.rows[0].updated_at };
    }
  }catch{
    try{
      const s = await db.execute({ sql:`SELECT id, proposed_times, agreed_time FROM pair_schedules WHERE pair_group_id=? LIMIT 1`, args:[grp.pg_id] });
      if (s.rows.length) schedule={ proposed_times: s.rows[0].proposed_times ? JSON.parse(s.rows[0].proposed_times) : [], agreed_time: s.rows[0].agreed_time||null };
    }catch{}
  }
  let messagesPreview=[];
  try{
    const m = await db.execute({ sql:`SELECT id, sender_id, message, created_at FROM pair_messages WHERE week_id=? AND pair_group_id=? ORDER BY id DESC LIMIT 3`, args:[weekId, grp.pg_id] });
    messagesPreview = m.rows.reverse().map(r=>({ id:r.id, sender_id:r.sender_id, message:r.message, created_at:r.created_at }));
  }catch{}
  const meRow = await db.execute({ sql:`SELECT id, display_name, color, tz, interview_focus FROM auth_accounts WHERE id=?`, args:[userId] }).catch(()=>({rows:[]}));
  const me = meRow.rows && meRow.rows[0] ? { id:meRow.rows[0].id, name:meRow.rows[0].display_name, color:meRow.rows[0].color, tz:meRow.rows[0].tz, interview_focus:meRow.rows[0].interview_focus } : { id:userId };
  const roomId = `week_${weekId}_pair_${grp.pg_id}`;
  return res.json({ ok:true, paired:true, room_id:roomId, week_id:weekId, week: weekRow ? { id:weekRow.id||weekId, week_label:weekRow.week_label, week_start:weekRow.week_start, focus:weekRow.focus } : { id:weekId }, pair: { pg_id:grp.pg_id, week_id:weekId, room_id:roomId, user_a_id:grp.user_a_id, user_b_id:grp.user_b_id, user_c_id:grp.user_c_id??null, is_ai_pair:isAI, is_ai:isAI, topic:grp.topic, topic_kind:grp.topic_kind }, partner, partners, me, schedule, messagesPreview });
}

async function handleSchedule(req,res){
  if (req.method === 'GET'){
    const payload = getAuthPayload(req);
    if (!payload) return res.status(401).json({ error:'missing Bearer' });
    const db = getClient();
    await ensureProfileMigrations(db);
    const weekId = req.query?.week_id ? parseInt(String(req.query.week_id),10) : null;
    const pairId = req.query?.pair_id ? parseInt(String(req.query.pair_id),10) : (req.query?.pg_id ? parseInt(String(req.query.pg_id),10) : null);
    if (!weekId || !pairId) return res.status(400).json({ error:'week_id and pair_id required' });
    const access=await getPairAccess(db,payload,weekId,pairId);
    if(!access.exists) return res.status(404).json({error:'pair not found'});
    if(!access.allowed) return res.status(403).json({error:'not member of this pair'});
    const s = await db.execute({ sql:`SELECT id, week_id, pair_group_id, proposed_times, agreed_time, created_at, updated_at FROM pair_schedules WHERE week_id=? AND pair_group_id=? LIMIT 1`, args:[weekId, pairId] }).catch(()=>({rows:[]}));
    if (!s.rows || !s.rows.length) return res.json({ ok:true, schedule:null });
    const row=s.rows[0];
    return res.json({ ok:true, schedule:{ id:row.id, week_id:row.week_id, pair_group_id:row.pair_group_id, proposed_times: row.proposed_times? JSON.parse(row.proposed_times):[], agreed_time:row.agreed_time||null, created_at:row.created_at, updated_at:row.updated_at }});
  }
  if (req.method !== 'POST'){
    return res.status(405).json({ error:'GET or POST only' });
  }
  const payload = getAuthPayload(req);
  if (!payload) return res.status(401).json({ error:'missing Bearer token' });
  const db = getClient();
  await ensureProfileMigrations(db);
  const userId = payload.id||payload.uid;
  const body = req.body||{};
  const weekId = body.week_id ? parseInt(String(body.week_id),10) : (req.query?.week_id? parseInt(String(req.query.week_id),10): null);
  const pairId = body.pair_id ? parseInt(String(body.pair_id),10) : (body.pg_id ? parseInt(String(body.pg_id),10) : (req.query?.pair_id? parseInt(String(req.query.pair_id),10): null));
  if (!weekId || !pairId) return res.status(400).json({ error:'week_id and pair_id required' });
  try{
    const access=await getPairAccess(db,payload,weekId,pairId);
    if(!access.exists) return res.status(404).json({error:'pair not found'});
    if(!access.allowed) return res.status(403).json({error:'not member of this pair'});
  }catch{ return res.status(500).json({ error:'db check failed' }); }
  const hasProposed=Object.prototype.hasOwnProperty.call(body,'proposed_times');
  const hasAgreed=Object.prototype.hasOwnProperty.call(body,'agreed_time');
  let proposed = null, agreed = null;
  if (hasProposed){
    if (Array.isArray(body.proposed_times)){
      proposed = JSON.stringify(body.proposed_times.map(s=>String(s).slice(0,200)).slice(0,20));
    } else if (typeof body.proposed_times==='string'){
      try{ const arr=JSON.parse(body.proposed_times); if(Array.isArray(arr)) proposed=JSON.stringify(arr.slice(0,20)); else proposed=JSON.stringify([body.proposed_times]); }catch{ proposed=JSON.stringify([String(body.proposed_times).slice(0,200)]); }
    }
  }
  if (hasAgreed){
    agreed = body.agreed_time ? String(body.agreed_time).trim().slice(0,200) : null;
  }
  try{
    await db.execute({
      sql:`INSERT INTO pair_schedules (week_id, pair_group_id, proposed_times, agreed_time, created_at, updated_at)
           VALUES (?,?,?,?,datetime('now'),datetime('now'))
           ON CONFLICT(week_id,pair_group_id) DO UPDATE SET
             proposed_times=CASE WHEN ?=1 THEN excluded.proposed_times ELSE pair_schedules.proposed_times END,
             agreed_time=CASE WHEN ?=1 THEN excluded.agreed_time ELSE pair_schedules.agreed_time END,
             updated_at=datetime('now')`,
      args:[weekId,pairId,hasProposed?proposed:JSON.stringify([]),agreed,hasProposed?1:0,hasAgreed?1:0],
    });
    const fresh = await db.execute({ sql:`SELECT id, week_id, pair_group_id, proposed_times, agreed_time, updated_at FROM pair_schedules WHERE week_id=? AND pair_group_id=? LIMIT 1`, args:[weekId, pairId] });
    const f=fresh.rows[0];
    return res.json({ ok:true, schedule:{ id:f.id, week_id:f.week_id, pair_group_id:f.pair_group_id, proposed_times: f.proposed_times? JSON.parse(f.proposed_times):[], agreed_time:f.agreed_time||null, updated_at:f.updated_at }});
  }catch{ return res.status(500).json({ error:'schedule upsert failed; verify the unique schedule migration' }); }
}

async function handleMessages(req,res){
  const payload = getAuthPayload(req);
  if (!payload) return res.status(401).json({ error:'missing Bearer token' });
  const db = getClient();
  await ensureProfileMigrations(db);
  const userId = payload.id||payload.uid;
  if (req.method === 'GET'){
    const weekId = req.query?.week_id ? parseInt(String(req.query.week_id),10) : null;
    const pairId = req.query?.pair_id ? parseInt(String(req.query.pair_id),10) : (req.query?.pg_id ? parseInt(String(req.query.pg_id),10) : null);
    if (!weekId || !pairId) return res.status(400).json({ error:'week_id and pair_id required' });
    const after = req.query?.after ? parseInt(String(req.query.after),10) : 0;
    try{
      const access=await getPairAccess(db,payload,weekId,pairId);
      if(!access.exists) return res.status(404).json({error:'pair not found'});
      if(!access.allowed) return res.status(403).json({error:'not member of this pair'});
      let sql = `SELECT pm.id, pm.sender_id, pm.message, pm.created_at, aa.display_name as sender_name, aa.color as sender_color FROM pair_messages pm LEFT JOIN auth_accounts aa ON aa.id=pm.sender_id WHERE pm.week_id=? AND pm.pair_group_id=?`;
      const args=[weekId, pairId];
      if (after){ sql+=` AND pm.id>?`; args.push(after); }
      sql+=` ORDER BY pm.id ASC LIMIT 100`;
      const rs = await db.execute({ sql, args });
      return res.json({ ok:true, messages: rs.rows.map(r=>({ id:r.id, sender_id:r.sender_id, sender_name:r.sender_name||`User ${r.sender_id}`, sender_color:r.sender_color||'#9aa0a6', message:r.message, created_at:r.created_at })), after: rs.rows.length? rs.rows[rs.rows.length-1].id : after });
    }catch(e){ return res.status(500).json({ error:'messages fetch failed', detail:String(e.message||e).slice(0,200)}); }
  }
  if (req.method === 'POST'){
    const body = req.body||{};
    const weekId = body.week_id ? parseInt(String(body.week_id),10) : null;
    const pairId = body.pair_id ? parseInt(String(body.pair_id),10) : (body.pg_id ? parseInt(String(body.pg_id),10) : null);
    const text = body.message ? String(body.message).trim().slice(0,2000) : '';
    if (!weekId || !pairId) return res.status(400).json({ error:'week_id and pair_id required' });
    if (!text) return res.status(400).json({ error:'message required' });
    try{
      const access=await getPairAccess(db,payload,weekId,pairId);
      if(!access.exists) return res.status(404).json({error:'pair not found'});
      if(!access.allowed) return res.status(403).json({error:'not member of this pair'});
    }catch{ return res.status(500).json({ error:'db check failed' }); }
    try{
      const ins = await db.execute({ sql:`INSERT INTO pair_messages (week_id, pair_group_id, sender_id, message, created_at) VALUES (?,?,?, ?, datetime('now')) RETURNING id`, args:[weekId, pairId, userId, text] });
      const id = ins.rows[0].id;
      const rs = await db.execute({ sql:`SELECT pm.id, pm.sender_id, pm.message, pm.created_at, aa.display_name as sender_name, aa.color as sender_color FROM pair_messages pm LEFT JOIN auth_accounts aa ON aa.id=pm.sender_id WHERE pm.id=?`, args:[id] });
      const r=rs.rows[0];
      return res.json({ ok:true, message:{ id:r.id, sender_id:r.sender_id, sender_name:r.sender_name||`User`, sender_color:r.sender_color, message:r.message, created_at:r.created_at }});
    }catch(e){ return res.status(500).json({ error:'insert failed', detail:String(e.message||e).slice(0,200)}); }
  }
  return res.status(405).json({ error:'GET or POST only' });
}

async function handleQuestions(req,res){
  if(!getAuthPayload(req)) return res.status(401).json({error:'authentication required'});
  if(req.method!=='GET') return res.status(405).json({error:'the bundled question catalogue is read-only'});

  const requestedSlug=String(req.query?.slug||req.query?.question_slug||'').trim();
  if(requestedSlug){
    const rawVersion=req.query?.version??req.query?.question_version;
    const activeQuestion=rawVersion==null || rawVersion===''
      ? listPublicExercises().find(question=>question.slug===requestedSlug)
      : null;
    if((rawVersion==null || rawVersion==='') && !activeQuestion){
      return res.status(404).json({error:'question not found or unavailable'});
    }
    const requestedVersion=activeQuestion?.version??Number(rawVersion);
    if(!Number.isInteger(requestedVersion) || requestedVersion<1){
      return res.status(400).json({error:'a positive integer question version is required'});
    }
    const question=getPublicExercise(requestedSlug,requestedVersion);
    if(!question) return res.status(404).json({error:'question not found or unavailable'});
    return res.json({ok:true,question});
  }

  const questions=listPublicExercises();
  return res.json({ok:true,questions,count:questions.length});
}

function runResultsDigest(resultsJson){
  return createHash('sha256').update(String(resultsJson||''),'utf8').digest('hex');
}

function runAttestationPayload({userId,questionSlug,questionVersion,language,passedCount,totalCount,resultsJson}){
  return JSON.stringify([
    2,
    Number(userId),
    String(questionSlug),
    Number(questionVersion),
    String(language),
    Number(passedCount),
    Number(totalCount),
    runResultsDigest(resultsJson),
  ]);
}

function runAttestationKeyId(secret){
  return createHash('sha256').update(`randori-run-key\0${secret}`,'utf8').digest('hex').slice(0,16);
}

function runAttestationKeyring(){
  const configured=String(process.env.RUN_ATTESTATION_SECRET||'').trim();
  const current=configured||getJwtSecret();
  if(current.length<32) throw new Error('RUN_ATTESTATION_SECRET must contain at least 32 characters');
  const previous=String(process.env.RUN_ATTESTATION_PREVIOUS_SECRETS||'')
    .split(',')
    .map(value=>value.trim())
    .filter(Boolean);
  if(previous.some(secret=>secret.length<32)){
    throw new Error('every RUN_ATTESTATION_PREVIOUS_SECRETS value must contain at least 32 characters');
  }
  return [current,...previous]
    .filter((secret,index,values)=>values.indexOf(secret)===index)
    .map(secret=>({id:runAttestationKeyId(secret),secret}));
}

function signRunAttestation(fields){
  const key=runAttestationKeyring()[0];
  return {
    keyId:key.id,
    signature:createHmac('sha256',key.secret)
      .update(`randori-run-attestation-v2\0${runAttestationPayload(fields)}`,'utf8')
      .digest('hex'),
  };
}

function verifyRunAttestation(signature,keyId,fields){
  try{
    if(typeof signature!=='string' || !/^[a-f0-9]{64}$/.test(signature)) return false;
    if(typeof keyId!=='string' || !/^[a-f0-9]{16}$/.test(keyId)) return false;
    const key=runAttestationKeyring().find(candidate=>candidate.id===keyId);
    if(!key) return false;
    const supplied=Buffer.from(signature,'hex');
    const expected=Buffer.from(
      createHmac('sha256',key.secret)
        .update(`randori-run-attestation-v2\0${runAttestationPayload(fields)}`,'utf8')
        .digest('hex'),
      'hex',
    );
    return supplied.length===expected.length && timingSafeEqual(supplied,expected);
  }catch{ return false; }
}

async function handleRuns(req,res){
  if(req.method!=='GET' && req.method!=='POST') return res.status(405).json({ error:'GET only' });
  const payload = getAuthPayload(req);
  if (!payload) return res.status(401).json({ error:'authentication required' });
  if (req.method === 'POST'){
    return res.status(405).json({error:'run records are created only by the execution service'});
  }
  const userId = payload.id || payload.uid;
  const db = getClient();
  await ensureBaseTables(db);
  await ensureProfileMigrations(db);
  await ensureSessionRuns(db);
  if (req.method === 'GET'){
    const slug = req.query?.question_slug || req.query?.slug ? String(req.query.question_slug||req.query.slug).slice(0,120) : null;
    const limit = Math.min(50, Math.max(1, parseInt(String(req.query?.limit||'20'),10)||20));
    try{
      let sql = `SELECT id, week_id, pair_group_id, question_id, question_slug, language, substr(code,1,500) as code_preview, test_cases_snapshot, results_json, passed_count, total_count, duration_ms, created_at FROM session_runs WHERE user_id=?`;
      let args=[userId];
      if (slug){ sql+=` AND question_slug=?`; args.push(slug); }
      sql+=` ORDER BY id DESC LIMIT ?`; args.push(limit);
      const rs = await db.execute({ sql, args });
      const runs=rs.rows.map(row=>{
        let questionVersion=null;
        let authoritative=false;
        try{
          const snapshot=row.test_cases_snapshot?JSON.parse(row.test_cases_snapshot):null;
          const version=positiveInteger(snapshot?.version);
          if(
            snapshot?.source==='original-catalog'
            && snapshot?.attestation_version===2
            && version
            && Number(snapshot.total_count)===Number(row.total_count)
          ){
            authoritative=verifyRunAttestation(snapshot.attestation,snapshot.attestation_key_id,{
              userId,
              questionSlug:row.question_slug,
              questionVersion:version,
              language:row.language,
              passedCount:row.passed_count,
              totalCount:row.total_count,
              resultsJson:row.results_json,
            });
            if(authoritative) questionVersion=version;
          }
        }catch{}
        const {test_cases_snapshot:_privateSnapshot,results_json:_privateResults,...publicRun}=row;
        return {...publicRun,question_version:questionVersion,authoritative};
      });
      return res.json({ ok:true, runs, count:runs.length });
    }catch(e){ return res.status(500).json({ error:'fetch failed', detail:String(e.message||e).slice(0,200)}); }
  }
}

async function handleStats(req,res){
  if (req.method !== 'GET') return res.status(405).json({ error:'GET only' });
  const db = getClient();
  await ensureBaseTables(db);
  await ensureProfileMigrations(db);
  const payload = getAuthPayload(req); // optional
  let total_users=0, total_weeks=0, total_pairs=0;
  try{
    const u = await db.execute(`SELECT COUNT(*) as c FROM auth_accounts WHERE COALESCE(is_demo,0)=0`);
    total_users = u.rows[0]?.c ?? 0;
  }catch{}
  try{
    const w = await db.execute(`SELECT COUNT(*) as c FROM pairing_weeks WHERE COALESCE(is_demo,0)=0`);
    total_weeks = w.rows[0]?.c ?? 0;
  }catch{}
  try{
    // count pairs in non-demo weeks
    const p = await db.execute(`SELECT COUNT(*) as c FROM pairing_groups pg JOIN pairing_weeks pw ON pw.id=pg.week_id WHERE COALESCE(pw.is_demo,0)=0`);
    total_pairs = p.rows[0]?.c ?? 0;
  }catch{
    try{
      const p2 = await db.execute(`SELECT COUNT(*) as c FROM pairing_groups`);
      total_pairs = p2.rows[0]?.c ?? 0;
    }catch{}
  }
  // Public stats
  const out = { ok:true, total_users, total_weeks, total_pairs, total_sessions: total_pairs, generated_at: new Date().toISOString() };
  if (payload){
    const userId = payload.id || payload.uid;
    try{
      const my = await db.execute({ sql:`SELECT COUNT(*) as c FROM pairing_groups WHERE user_a_id=? OR user_b_id=? OR user_c_id=?`, args:[userId,userId,userId] });
      out.your_sessions = my.rows[0]?.c ?? 0;
    }catch{}
    try{
      const last = await db.execute({ sql:`SELECT pg.id as pg_id, pg.week_id, pw.week_label, pw.week_start, pg.is_ai_pair FROM pairing_groups pg JOIN pairing_weeks pw ON pw.id=pg.week_id WHERE (pg.user_a_id=? OR pg.user_b_id=? OR pg.user_c_id=?) AND COALESCE(pw.is_demo,0)=0 ORDER BY pw.id DESC LIMIT 1`, args:[userId,userId,userId] });
      if (last.rows.length) out.your_last = last.rows[0];
    }catch{}
    try{
      const yWeeks = await db.execute({ sql:`SELECT COUNT(DISTINCT week_id) as c FROM pairing_groups WHERE user_a_id=? OR user_b_id=? OR user_c_id=?`, args:[userId,userId,userId] });
      out.your_weeks = yWeeks.rows[0]?.c ?? 0;
    }catch{}
  }
  // next shuffle countdown — Sunday 07:00 UTC == 08:00 BST
  try{
    const now = new Date();
    const next = new Date(now);
    // compute next Sunday 07:00 UTC
    const day = next.getUTCDay(); // 0 Sun
    let diff = (7 - day) % 7;
    if (diff===0){
      // today is Sunday, check if past 07:00
      const h = next.getUTCHours();
      if (h>=7) diff=7;
    }
    next.setUTCDate(now.getUTCDate()+diff);
    next.setUTCHours(7,0,0,0);
    out.next_shuffle_utc = next.toISOString();
    out.next_shuffle_bst = new Date(next.getTime()).toLocaleString('en-GB',{timeZone:'Europe/London', weekday:'long', hour:'2-digit', minute:'2-digit'}) + ' BST';
    out.next_shuffle_label = `Sunday 08:00 BST • ${next.toLocaleDateString('en-GB',{timeZone:'Europe/London', day:'numeric', month:'short'})}`;
  }catch{}
  return res.json(out);
}

// ----- LeetCode proxy endpoints -----
async function handleLeetcode(req,res){
  // GET ?slug=two-sum or /api/leetcode/two-sum
  if (req.method!=='GET') return res.status(405).json({ error:'GET only for leetcode detail' });
  if(!getAuthPayload(req)) return res.status(401).json({error:'authentication required'});
  const db = getClient();
  await ensureBaseTables(db); await ensureProfileMigrations(db);
  const url = new URL(req.url, 'http://localhost');
  let slug = (req.query?.slug || url.searchParams.get('slug') || '').toString().trim().toLowerCase();
  if (!slug){
    // try to parse from pathname /api/leetcode/two-sum
    const parts = url.pathname.split('/').filter(Boolean);
    const idx = parts.findIndex(p=>p.toLowerCase().includes('leet'));
    if (idx>=0 && parts[idx+1]) slug = parts[idx+1].toLowerCase();
  }
  if (!slug) return res.status(400).json({ error:'slug required, e.g. ?slug=two-sum' });

  // Check cache first (DB)
  try{
    const cached = await db.execute({ sql:`SELECT id, slug, title, difficulty, category, description, test_cases, examples, leetcode_slug, source FROM custom_questions WHERE leetcode_slug=? OR slug=? LIMIT 1`, args:[slug, slug] });
    if (cached.rows.length){
      const r=cached.rows[0];
      let tcs=[]; try{ tcs=JSON.parse(r.test_cases||'[]')}catch{}
      let ex=[]; try{ ex=JSON.parse(r.examples||'[]')}catch{}
      return res.json({ ok:true, cached:true, question:{ id:r.id, slug:r.slug, title:r.title, difficulty:r.difficulty, category:r.category, description:r.description, test_cases:tcs, examples:ex, leetcode_slug:r.leetcode_slug, source:r.source, slug }});
    }
  }catch{}

  return res.status(404).json({
    ok:false,
    error:'problem is not in the approved local catalog',
    slug,
    external_url:`https://leetcode.com/problems/${encodeURIComponent(slug)}/`,
    automated_fetch:false,
  });
}

async function handleLeetcodeSync(req,res){
  if (req.method!=='POST') return res.status(405).json({ error:'POST only for leetcode-sync' });
  const adminCtx = await requireAdminDT(req,res);
  if (!adminCtx) return;
  if(process.env.LEETCODE_INGESTION_AUTHORIZED!=='true'){
    return res.status(403).json({error:'automated LeetCode ingestion is disabled pending written authorization'});
  }
  const db = adminCtx.db;
  await ensureBaseTables(db); await ensureProfileMigrations(db);
  const url = new URL(req.url,'http://localhost');
  const limit = Math.min(50, Math.max(1, parseInt(String(req.query?.limit||url.searchParams.get('limit')||'20'),10)||20));
  const skip = Math.max(0, parseInt(String(req.query?.skip||url.searchParams.get('skip')||'0'),10)||0);
  const singleSlug = (req.query?.slug||url.searchParams.get('slug')||req.body?.slug||'').toString().trim().toLowerCase();
  let slugsInfo;
  let slugs=[];
  if (singleSlug){
    slugs=[singleSlug];
    slugsInfo={ total:1, slugs };
  }else{
    try{ slugsInfo = await leetListSlugs(limit, skip); slugs = slugsInfo.slugs||[]; }
    catch(e){ return res.status(500).json({ error:'failed to list slugs', detail:String(e.message||e).slice(0,200)}); }
  }
  // If list empty, try to fallback to provided body.slugs array
  if (!slugs.length && Array.isArray(req.body?.slugs)) slugs = req.body.slugs.map(s=>String(s).toLowerCase().trim()).filter(Boolean).slice(0,limit);
  if (!slugs.length) return res.status(400).json({ error:'no slugs to sync', hint:'pass ?slug=two-sum or ensure LeetCode list fetch works' });

  const synced=[]; const errors=[];
  for (let i=0;i<slugs.length;i++){
    const slug = slugs[i];
    try{
      if (i>0 && i%3===0) await sleep(800); // rate limit to avoid 429
      const q = await leetGraphQLQuestion(slug);
      const descHtml = q.content||'';
      const descText = htmlToText(descHtml)||q.title;
      const difficulty = q.difficulty||'Medium';
      const tags = (q.topicTags||[]).map(t=>t.slug||t.name).slice(0,3);
      const category = tags[0]||'dsa';
      let testCases = smartChunkExampleTestcases(slug, q.exampleTestcases||'', descHtml);
      // enrichment attempt (best-effort) – merge alfa
      try{
        const alfa = await leetEnrichAlfa(slug);
        if (alfa && alfa.exampleTestcases){
          const alfaCases = smartChunkExampleTestcases(slug, alfa.exampleTestcases, alfa.content||descHtml);
          const seen = new Set(testCases.map(t=>t.input));
          for(const ac of alfaCases){ if(!seen.has(ac.input)){ testCases.push(ac); seen.add(ac.input); } }
        }
      }catch{}
      // edges
      try{
        const edges = enrichmentEdges(slug);
        const seen = new Set(testCases.map(t=>t.input));
        for(const e of edges){ if(!seen.has(e.input)){ testCases.push(e); seen.add(e.input); } }
      }catch{}
      if (!testCases.length) testCases=[{ input:JSON.stringify({raw:`example from ${slug}`}), expect:null, raw:`see description` }];
      const constraints = parseLeetConstraints(descHtml);
      const examplesStr = JSON.stringify(testCases.slice(0,5).map(tc=>({ input: tc.input, output: tc.expect||'', raw: tc.raw }))).slice(0,4000);
      const tcsStr = JSON.stringify(testCases).slice(0,15000);
      // upsert
      await db.execute({ sql:`INSERT INTO custom_questions (slug, title, type, difficulty, category, description, input_format, constraints_text, examples, test_cases, starter_per_lang, author_id, source, leetcode_slug, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
        ON CONFLICT(slug) DO UPDATE SET
          title=excluded.title,
          difficulty=excluded.difficulty,
          category=excluded.category,
          description=excluded.description,
          constraints_text=excluded.constraints_text,
          examples=excluded.examples,
          test_cases=excluded.test_cases,
          source=excluded.source,
          leetcode_slug=excluded.leetcode_slug
      `, args:[
        slug,
        q.title||slug,
        'dsa',
        difficulty,
        category,
        descText,
        null,
        constraints||null,
        examplesStr,
        tcsStr,
        JSON.stringify({}),
        adminCtx.payload.id||adminCtx.callerId||null,
        'leetcode',
        q.titleSlug||slug
      ]});
      try{ await logServer('info','leetcode_sync_progress', `synced ${slug} ${i+1}/${slugs.length} tc=${testCases.length}`, {skip, slug, idx:i, tc:testCases.length}, {req, source:'server', route:req.url}); }catch{}
      synced.push({ slug, title:q.title, difficulty, category, test_cases_count:testCases.length });
    }catch(e){
      try{ await logServer('warn','leetcode_sync_error', `fail ${slug} ${String(e.message||e).slice(0,120)}`, {slug, err:String(e.message||e).slice(0,300)}, {req, source:'server'}); }catch{}
      errors.push({ slug, error:String(e.message||e).slice(0,200) });
    }
    // Vercel Hobby 10s budget guard: if we exceed 9s we break – caller paginates with skip
    if (i>=14 && (Date.now()%1000===0)) { /*noop*/ }
  }
  return res.json({ ok:true, synced_count:synced.length, total_requested: slugs.length, skip, limit, total_available: slugsInfo?.total||null, synced, errors, note:`Enriched: merged GraphQL exampleTestcases + alfa-leetcode-api + hand-crafted edges. Pagination via ?skip=&limit=. Each call 800ms throttled to avoid 429. Auto-seed /api/questions when <10 uses same enrichment.` });
}


async function pistonVersions(){
  try{
    const r = await fetchWithTimeout('https://emkc.org/api/v2/piston/runtimes', {}, 6000);
    if(r.ok){ const j=await r.json(); return j; }
  }catch{} return [];
}

async function callPistonAPI(language, version, files){
  const body = { language, version, files: files.map(f=>({name:f.name, content:f.content})) };
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),12000);
  const maxResponseBytes=256*1024;
  try{
    const r=await fetch('https://emkc.org/api/v2/piston/execute',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body),
      signal:controller.signal,
    });
    if(!r.ok) throw new Error(`piston request failed with status ${r.status}`);
    const declaredLength=Number(r.headers.get('content-length'));
    if(Number.isFinite(declaredLength) && declaredLength>maxResponseBytes){
      controller.abort();
      throw new Error('piston response exceeded size limit');
    }
    const reader=r.body?.getReader?.();
    if(!reader){
      const text=await r.text();
      if(Buffer.byteLength(text,'utf8')>maxResponseBytes) throw new Error('piston response exceeded size limit');
      return JSON.parse(text);
    }
    const chunks=[];
    let received=0;
    while(true){
      const {done,value}=await reader.read();
      if(done) break;
      received+=value.byteLength;
      if(received>maxResponseBytes){
        await reader.cancel().catch(()=>{});
        throw new Error('piston response exceeded size limit');
      }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks,received).toString('utf8'));
  }finally{
    clearTimeout(timeout);
  }
}

function encodeRunnerPayload(value){
  return Buffer.from(JSON.stringify(value),'utf8').toString('base64');
}

function buildJsHarness(userCode,testSuite,resultPrefix){
  const encodedSuite=encodeRunnerPayload({
    entrypoint:testSuite.entrypoint,
    tests:testSuite.tests.map(test=>({args:test.args})),
  });
  const encodedCode=Buffer.from(userCode,'utf8').toString('base64');
  return `;(function(){
  const __randori_bundle=JSON.parse(Buffer.from('${encodedSuite}','base64').toString('utf8'));
  const __randori_source=Buffer.from('${encodedCode}','base64').toString('utf8');
  const __randori_vm=require('node:vm');
  const __randori_context=__randori_vm.createContext(Object.create(null),{codeGeneration:{strings:false,wasm:false}});
  let __randori_ready=true;
  try{ __randori_vm.runInContext(__randori_source,__randori_context,{timeout:1000}); }catch{ __randori_ready=false; }
  for(let index=0;index<__randori_bundle.tests.length;index++){
    const test=__randori_bundle.tests[index];
    let got=null, ok=false, error=null;
    try{
      if(!__randori_ready) throw new Error('submission did not load');
      __randori_context.__randori_args_json__=JSON.stringify(test.args);
      const expression='JSON.stringify('+__randori_bundle.entrypoint+'(...JSON.parse(__randori_args_json__)))';
      const serialized=__randori_vm.runInContext(expression,__randori_context,{timeout:1000});
      got=JSON.parse(serialized);
      ok=true;
    }catch{ error='runtime error'; }
    process.stdout.write('${resultPrefix}'+JSON.stringify({idx:index,ok,got,error})+'\\n');
  }
})();
`;
}

function buildPythonHarness(userCode,testSuite,resultPrefix){
  const encodedSuite=encodeRunnerPayload({
    entrypoint:testSuite.entrypoint,
    tests:testSuite.tests.map(test=>({args:test.args})),
  });
  const encodedCode=Buffer.from(userCode,'utf8').toString('base64');
  return `import base64 as __randori_base64
import json as __randori_json

def __randori_run():
    bundle=__randori_json.loads(__randori_base64.b64decode('${encodedSuite}').decode('utf-8'))
    source=__randori_base64.b64decode('${encodedCode}').decode('utf-8')
    safe_builtins={
        'Exception':Exception,'IndexError':IndexError,'KeyError':KeyError,'TypeError':TypeError,
        'ValueError':ValueError,'abs':abs,'all':all,'any':any,'bool':bool,'chr':chr,'dict':dict,'divmod':divmod,
        'enumerate':enumerate,'filter':filter,'float':float,'int':int,'isinstance':isinstance,
        'len':len,'list':list,'map':map,'max':max,'min':min,'next':next,'object':object,'ord':ord,
        'pow':pow,'range':range,'reversed':reversed,'round':round,'set':set,'sorted':sorted,
        'str':str,'sum':sum,'tuple':tuple,'zip':zip,
    }
    namespace={'__builtins__':safe_builtins}
    ready=True
    try:
        exec(compile(source,'submission.py','exec'),namespace,namespace)
    except Exception:
        ready=False
    fn=namespace.get(bundle['entrypoint'])
    for index,test in enumerate(bundle['tests']):
        ok=False
        got=None
        error=None
        try:
            if not ready or not callable(fn):
                raise RuntimeError('entrypoint not found')
            got=fn(*test['args'])
            __randori_json.dumps(got,separators=(',',':'))
            ok=True
        except Exception:
            error='runtime error'
        print('${resultPrefix}'+__randori_json.dumps({'idx':index,'ok':ok,'got':got,'error':error},separators=(',',':')))

__randori_run()
`;
}

function runnerValuesEqual(a,b){
  if(Object.is(a,b)) return true;
  if(Array.isArray(a) && Array.isArray(b)){
    return a.length===b.length && a.every((value,index)=>runnerValuesEqual(value,b[index]));
  }
  if(a && b && typeof a==='object' && typeof b==='object'){
    const aKeys=Object.keys(a), bKeys=Object.keys(b);
    return aKeys.length===bKeys.length
      && aKeys.every(key=>Object.prototype.hasOwnProperty.call(b,key) && runnerValuesEqual(a[key],b[key]));
  }
  return false;
}

function normalizeRunnerResults(stdout,resultPrefix,tests){
  const byIndex=new Map();
  for(const line of String(stdout||'').split('\n')){
    const value=line.trim();
    if(!value.startsWith(resultPrefix) || value.length>100000) continue;
    try{
      const parsed=JSON.parse(value.slice(resultPrefix.length));
      if(!Number.isInteger(parsed.idx) || parsed.idx<0 || parsed.idx>=tests.length || typeof parsed.ok!=='boolean') continue;
      const pass=parsed.ok && runnerValuesEqual(parsed.got,tests[parsed.idx].expected);
      byIndex.set(parsed.idx,{idx:parsed.idx,pass,error:parsed.error ? 'runtime error' : null});
    }catch{}
  }
  return tests.map((_,idx)=>byIndex.get(idx)||{idx,pass:false,error:'no result'});
}

function positiveInteger(value){
  const parsed=Number(value);
  return Number.isInteger(parsed) && parsed>0 ? parsed : null;
}

async function acquireExecutionLease(db,userId,req,metadata){
  const route=String(req.url||'').slice(0,300);
  const userAgent=String(req.headers?.['user-agent']||'').slice(0,300);
  const ip=String(req.headers?.['x-forwarded-for']||'').split(',')[0].trim().slice(0,80);
  const result=await db.execute({
    sql:`INSERT INTO app_logs (level, source, event, message, meta_json, user_id, route, ua, ip, created_at)
      SELECT 'info','runner','execute_lease_start','execution lease acquired',?,?,?,?,?, datetime('now')
      WHERE NOT EXISTS (
        SELECT 1 FROM app_logs lease_start
        WHERE lease_start.user_id=?
          AND lease_start.source='runner'
          AND lease_start.event='execute_lease_start'
          AND datetime(lease_start.created_at)>=datetime('now','-30 seconds')
          AND NOT EXISTS (
            SELECT 1 FROM app_logs lease_end
            WHERE lease_end.user_id=lease_start.user_id
              AND lease_end.source='runner'
              AND lease_end.event='execute_lease_end'
              AND lease_end.id>lease_start.id
              AND lease_end.message=CAST(lease_start.id AS TEXT)
          )
      )
      RETURNING id`,
    args:[JSON.stringify(metadata),userId,route,userAgent,ip,userId],
  });
  return positiveInteger(result.rows[0]?.id);
}

async function releaseExecutionLease(db,userId,leaseId,req){
  if(!leaseId) return;
  try{
    await db.execute({
      sql:`INSERT INTO app_logs (level, source, event, message, meta_json, user_id, route, ua, ip, created_at) VALUES ('info','runner','execute_lease_end',?,?,?,?,?,?, datetime('now'))`,
      args:[String(leaseId),JSON.stringify({lease_id:leaseId}),userId,String(req.url||'').slice(0,300),String(req.headers?.['user-agent']||'').slice(0,300),String(req.headers?.['x-forwarded-for']||'').split(',')[0].trim().slice(0,80)],
    });
  }catch(e){
    captureSentryException(e,{tags:{event:'execute_lease_release_fail',source:'runner'}});
  }
}

async function handleExecute(req,res){
  const _execStart=Date.now();
  if(req.method!=='POST') return res.status(405).json({error:'POST only for execute'});
  const payload=getAuthPayload(req);
  if(!payload) return res.status(401).json({error:'authentication required'});
  const body = req.body || {};
  const language = String(body.language||body.lang||'javascript').toLowerCase();
  const map = {js:'javascript', javascript:'javascript', py:'python', python:'python'};
  const pistonLang = map[language];
  if(!pistonLang) return res.status(400).json({error:'supported languages are javascript and python'});
  const code = String(body.code||'');
  if(!code) return res.status(400).json({error:'code required'});
  if(Buffer.byteLength(code,'utf8')>20000) return res.status(413).json({error:'code exceeds the 20000-byte limit'});

  const questionSlug=String(body.question_slug||body.slug||'').trim().slice(0,120);
  if(!questionSlug) return res.status(400).json({error:'question_slug required'});
  const rawQuestionVersion=body.question_version??body.version;
  const questionVersion=rawQuestionVersion==null || rawQuestionVersion===''
    ? listPublicExercises().find(question=>question.slug===questionSlug)?.version??null
    : positiveInteger(rawQuestionVersion);
  if(rawQuestionVersion!=null && rawQuestionVersion!=='' && !questionVersion){
    return res.status(400).json({error:'question_version must be a positive integer'});
  }
  const testSuite=createEvaluationSuite(questionSlug,questionVersion,pistonLang);
  if(!testSuite) return res.status(404).json({error:'question not found or unavailable'});

  // Schema creation is a deploy-time migration concern. Request handling stays
  // read/write-only and fails closed if the deployment has not been prepared.
  const db=getClient();

  const weekId=body.week_id==null || body.week_id==='' ? null : positiveInteger(body.week_id);
  const rawPairId=body.pair_group_id??body.pg_id??body.pair_id;
  const pairId=rawPairId==null || rawPairId==='' ? null : positiveInteger(rawPairId);
  if((weekId===null)!==(pairId===null)) return res.status(400).json({error:'week_id and pair_group_id must be provided together'});
  if((body.week_id!=null && body.week_id!=='' && !weekId) || (rawPairId!=null && rawPairId!=='' && !pairId)){
    return res.status(400).json({error:'week_id and pair_group_id must be positive integers'});
  }
  if(weekId && pairId){
    const access=await getPairAccess(db,payload,weekId,pairId);
    if(!access.exists) return res.status(404).json({error:'pair not found'});
    if(!access.allowed) return res.status(403).json({error:'not member of this pair'});
  }

  // Client test cases and result/count fields are deliberately ignored. The exact
  // versioned suite is resolved above from the private server catalogue.
  const runtimeVersions={javascript:'18.15.0',python:'3.10.0'};
  const runtimeVersion=runtimeVersions[pistonLang];
  const resultPrefix=`__RANDORI_RESULT_${randomBytes(16).toString('hex')}__:`;
  const harness=pistonLang==='javascript'
    ? buildJsHarness(code,testSuite,resultPrefix)
    : buildPythonHarness(code,testSuite,resultPrefix);
  const filename=pistonLang==='javascript' ? 'main.js' : 'main.py';

  const userId=positiveInteger(payload.id||payload.uid);
  if(!userId) return res.status(401).json({error:'authentication required'});
  const executionKey=String(userId);
  if(__activeExecutionsByUser.has(executionKey)){
    return res.status(429).json({error:'an execution is already in progress',retry_after_seconds:1});
  }
  __activeExecutionsByUser.add(executionKey);
  let leaseId=null;
  try{
    leaseId=await acquireExecutionLease(db,userId,req,{question_slug:questionSlug,question_version:questionVersion,language:pistonLang});
    if(!leaseId){
      __activeExecutionsByUser.delete(executionKey);
      return res.status(429).json({error:'an execution is already in progress',retry_after_seconds:30});
    }
    const rateResults=await db.batch([{
      sql:`INSERT INTO app_logs (level, source, event, message, meta_json, user_id, route, ua, ip, created_at) VALUES ('info','runner','execute_attempt','execution requested',?,?,?,?,?, datetime('now'))`,
      args:[JSON.stringify({question_slug:questionSlug,question_version:questionVersion,language:pistonLang}),userId,String(req.url||'').slice(0,300),String(req.headers?.['user-agent']||'').slice(0,300),String(req.headers?.['x-forwarded-for']||'').split(',')[0].trim().slice(0,80)],
    },{
      sql:`SELECT COUNT(*) as c FROM app_logs WHERE user_id=? AND source='runner' AND event='execute_attempt' AND datetime(created_at)>=datetime('now','-1 minute')`,
      args:[userId],
    }],'write');
    const recent=rateResults[1];
    if(Number(recent?.rows?.[0]?.c||0)>EXECUTIONS_PER_MINUTE){
      await releaseExecutionLease(db,userId,leaseId,req);
      leaseId=null;
      __activeExecutionsByUser.delete(executionKey);
      return res.status(429).json({error:'execution rate limit exceeded',retry_after_seconds:60});
    }
  }catch(e){
    await releaseExecutionLease(db,userId,leaseId,req);
    leaseId=null;
    __activeExecutionsByUser.delete(executionKey);
    captureSentryException(e,{tags:{event:'execute_rate_limit_fail',source:'runner'}});
    return res.status(503).json({error:'execution service unavailable'});
  }

  try{
    const pistonRes = await callPistonAPI(pistonLang,runtimeVersion,[{name:filename,content:harness}]);
    const run = pistonRes.run || {};
    const stdout = String(run.stdout||'');
    const stderr = String(run.stderr||'');
    const results=normalizeRunnerResults(stdout,resultPrefix,testSuite.tests);
    const passed = results.filter(r=>r.pass===true).length;
    const dur = Date.now()-_execStart;
    const total=testSuite.tests.length;
    let runId=null;
    try{
      const storedResults=JSON.stringify(results);
      const attestation=signRunAttestation({
        userId,
        questionSlug,
        questionVersion,
        language:pistonLang,
        passedCount:passed,
        totalCount:total,
        resultsJson:storedResults,
      });
      const testSnapshot=JSON.stringify({source:'original-catalog',version:questionVersion,total_count:total,attestation_version:2,attestation_key_id:attestation.keyId,attestation:attestation.signature});
      const inserted=await db.execute({
        sql:`INSERT INTO session_runs (user_id, week_id, pair_group_id, question_id, question_slug, language, code, test_cases_snapshot, results_json, passed_count, total_count, duration_ms, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?, ?, datetime('now')) RETURNING id`,
        args:[payload.id||payload.uid,weekId,pairId,null,questionSlug,pistonLang,code,testSnapshot,storedResults,passed,total,dur],
      });
      runId=inserted.rows[0]?.id??null;
    }catch(e){
      captureSentryException(e,{tags:{event:'run_persist_fail',source:'runner'},extra:{question_slug:questionSlug,question_version:questionVersion}});
      return res.status(500).json({ok:false,error:'execution result could not be saved'});
    }
    try{ await logServer(passed===total?'success':'info','execute_success',`piston ${pistonLang} ${passed}/${total} in ${dur}ms`,{language:pistonLang,runtimeVersion,questionSlug,questionVersion,passed,total,dur,hasStderr:!!stderr,runId},{req,payload,source:'runner',route:req.url,skipEnsure:true}); }catch{}
    await releaseExecutionLease(db,userId,leaseId,req);
    leaseId=null;
    __activeExecutionsByUser.delete(executionKey);
    return res.json({
      ok:true,
      question_slug:questionSlug,
      question_version:questionVersion,
      language:pistonLang,
      version:runtimeVersion,
      runtime_version:runtimeVersion,
      piston:{
        code:Number.isInteger(run.code)?run.code:null,
        signal:typeof run.signal==='string'?run.signal.slice(0,64):null,
        has_stderr:!!stderr,
      },
      results,
      passed_count:passed,
      total_count:total,
      run_id:runId,
    });
  }catch(e){
    try{ await logServer('error','execute_fail',`piston ${pistonLang} request failed`,{language:pistonLang},{req,source:'runner',route:req.url,skipEnsure:true}); }catch{}
    return res.status(500).json({ok:false,error:'piston execute failed',language:pistonLang});
  }finally{
    await releaseExecutionLease(db,userId,leaseId,req);
    __activeExecutionsByUser.delete(executionKey);
  }
}

export default async function handler(req,res){
  if(!verifyMutationOrigin(req)) return res.status(403).json({error:'cross-origin mutation rejected'});
  try{ 
    try{ initSentry(); }catch{}
  }catch{}
  try{
  const ep = getEndpoint(req);
  const path = (req.url||'').toLowerCase();
  if (ep==='runs' || ep==='session_runs' || ep==='session-runs' || path.includes('/runs')) return await handleRuns(req,res);
  if (ep==='leetcode-sync' || ep==='leetcode_sync' || path.includes('leetcode/sync') || path.includes('leetcode-sync')) return await handleLeetcodeSync(req,res);
  if (ep==='leetcode' || ep==='leetcode-detail' || ep==='leetcode_detail' || path.includes('/leetcode')) return await handleLeetcode(req,res);
  if (ep==='circle' || path.includes('/circle')) return await handleCircle(req,res);
  if (ep==='weeks' || path.includes('/weeks')) return await handleWeeks(req,res);
  if (ep==='history' || path.includes('/history')) return await handleHistory(req,res);
  if (ep==='stats' || path.includes('/stats')) return await handleStats(req,res);
  if (ep==='init' || path.includes('/init')) return await handleInit(req,res);
  if (ep==='profile' || path.includes('/profile')) return await handleProfile(req,res);
  if (ep==='my-pair' || path.includes('my-pair') || ep==='mypair' || path.includes('my_pair') || ep==='my_pair') return await handleMyPair(req,res);
  if (ep==='schedule' || path.includes('/schedule')) return await handleSchedule(req,res);
  if (ep.includes('message')) return await handleMessages(req,res);
  if (ep==='execute' || ep==='run' || path.includes('/execute')) return await handleExecute(req,res);
  if (ep==='health' || path.includes('/health') || ep==='healthz') return await handleHealth(req,res);
  if (ep==='logs' || path.includes('/logs') || ep==='applogs' || ep==='app_logs') return await handleLogs(req,res);
  if (ep==='questions' || ep==='question' || path.includes('/questions')) return await handleQuestions(req,res);
  return res.status(404).json({ error:`unknown data endpoint '${ep}'`, available:['health','runs','execute','logs','leetcode','leetcode-sync','circle','weeks','history','stats','init','profile','my-pair','schedule','messages','questions'] });
  }catch(e){
    const failedEndpoint=getEndpoint(req);
    const failedPath=String(req?.url||'').toLowerCase();
    const skipEnsure=failedEndpoint==='execute'||failedEndpoint==='run'||failedPath.includes('/execute');
    try{ await logServer('error','api_unhandled', String(e && e.message||e).slice(0,500), {stack: e && e.stack ? String(e.stack).slice(0,2000):'', url: req && req.url}, {req, source:'server', route: req && req.url, skipSentry:true, skipEnsure}); }catch{}
    captureSentryException(e, {tags:{event:'api_unhandled', source:'server'}, extra:{route:req && req.url}});
    try{ console.error('[api unhandled]', e && e.stack||e); }catch{}
    return res.status(500).json({error:'internal', detail: String(e && e.message||e).slice(0,300)});
  }
}
// auto-seed from bundled file on first questions request
async function maybeSeedFromStatic(db){
  try{
    let seed=null;
    const tryPaths = ['/vercel/path0/data/leetcode-seed.json', './data/leetcode-seed.json', 'data/leetcode-seed.json', '../data/leetcode-seed.json'];
    for(const cand of tryPaths){
      try{
        const fs=await import('fs');
        const pathMod=await import('path');
        const abs=cand.startsWith('/')?cand:pathMod.resolve(cand);
        if(fs.existsSync(abs) || fs.existsSync(cand)){
          const file = fs.existsSync(cand) ? cand : abs;
          seed=JSON.parse(fs.readFileSync(file,'utf8'));
          if(seed) break;
        }
      }catch{}
    }
    if(!seed){
      try{
        const fs2=await import('fs');
        const p2=new URL('../data/leetcode-seed.json', import.meta.url);
        if(fs2.existsSync(p2)) seed=JSON.parse(fs2.readFileSync(p2,'utf8'));
      }catch{}
    }
    if(!seed||!seed.length) return;
    // Upsert enriched seed (ON CONFLICT) — always upsert to migrate old 3-case seeds to enriched 6-case
    for(const q of seed){
      try{
        const enrichedTC = q.test_cases || [];
        const slug = q.slug;
        let mergedTC = enrichedTC;
        try{
          const edges = enrichmentEdges(slug);
          const seen = new Set((enrichedTC||[]).map(t=>t.input));
          for(const e of edges){ if(!seen.has(e.input)){ mergedTC.push(e); seen.add(e.input); } }
        }catch{}
        await db.execute({ sql:`INSERT INTO custom_questions (slug,title,type,difficulty,category,description,test_cases,examples,source,leetcode_slug) VALUES (?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(slug) DO UPDATE SET
            title=excluded.title,
            difficulty=excluded.difficulty,
            category=excluded.category,
            description=excluded.description,
            test_cases=excluded.test_cases,
            examples=excluded.examples,
            source=excluded.source,
            leetcode_slug=excluded.leetcode_slug
        `, args:[q.slug,q.title, q.type||'dsa', q.difficulty||'Medium', q.category||'custom', q.description, JSON.stringify(mergedTC||[]), JSON.stringify(q.examples||[]), q.source||'leetcode', q.leetcode_slug||q.slug]});
      }catch{}
    }
  }catch{}
}
