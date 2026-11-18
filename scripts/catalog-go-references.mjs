// Independently authored offline Go references. Server/tooling only. No member
// code, execution providers or network access. JSON numbers decode to float64.
const HELPERS = `package main
import "sort"
func arr(v interface{}) []interface{} { return v.([]interface{}) }
func num(v interface{}) int { return int(v.(float64)) }
func obj(v interface{}) map[string]interface{} { return v.(map[string]interface{}) }
func str(v interface{}) string { return v.(string) }
func min(a,b int) int { if a<b { return a }; return b }
func max(a,b int) int { if a>b { return a }; return b }
func sortedKeys(m map[string]interface{}) []string { keys:=make([]string,0,len(m)); for key:=range m { keys=append(keys,key) }; sort.Strings(keys); return keys }
`;
const PROGRAMS = {
  'focus-block-rollup@1': `func rollUpFocusBlocks(blocks interface{}) interface{} {
    result:=make([]map[string]interface{},0)
    for _,v:=range arr(blocks) { b:=obj(v); n:=len(result); if n>0 && result[n-1]["label"]==b["label"] { result[n-1]["minutes"]=result[n-1]["minutes"].(int)+num(b["minutes"]) } else { result=append(result,map[string]interface{}{"label":b["label"],"minutes":num(b["minutes"])}) } }
    return result
  }`,
  'balanced-template-markers@1': `func balancedTemplateMarkers(template interface{}) interface{} {
    stack:=make([]rune,0); opening:=map[rune]rune{')':'(',']':'[','}':'{'}
    for _,c:=range str(template) { if c=='('||c=='['||c=='{' { stack=append(stack,c) } else if want,ok:=opening[c];ok { if len(stack)==0||stack[len(stack)-1]!=want { return false }; stack=stack[:len(stack)-1] } }
    return len(stack)==0
  }`,
  'capacity-upgrade-index@1': `func capacityUpgradeIndex(capacities, required interface{}) interface{} {
    values:=arr(capacities); target:=num(required); index:=sort.Search(len(values),func(i int) bool{return num(values[i])>=target}); if index==len(values){return -1}; return index
  }`,
  'delivery-receipt-ledger@1': `func deliveryReceiptLedger(receipts interface{}) interface{} {
    seen:=map[string]bool{}; totals:=map[string]interface{}{}
    for _,v:=range arr(receipts) { r:=obj(v); id:=str(r["id"]); if seen[id]{continue}; seen[id]=true; destination:=str(r["destination"]); prior:=0; if totals[destination]!=nil{prior=totals[destination].(int)}; totals[destination]=prior+num(r["units"]) }
    out:=make([]map[string]interface{},0); for _,key:=range sortedKeys(totals){out=append(out,map[string]interface{}{"destination":key,"units":totals[key]})}; return out
  }`,
  'shard-window-audit@1': `func shardWindowAudit(events, queries interface{}) interface{} {
    out:=make([]int,0); for _,q:=range arr(queries){query:=arr(q); sum:=0; for _,e:=range arr(events){event:=arr(e); if event[0]==query[0]&&num(event[1])>=num(query[1])&&num(event[1])<num(query[2]){sum+=num(event[2])}}; out=append(out,sum)}; return out
  }`,
  'retry-credit-rounds@1': `func retryCreditRounds(lanes, slots interface{}) interface{} {
    list:=append([]interface{}{},arr(lanes)...); sort.Slice(list,func(i,j int)bool{return str(obj(list[i])["id"])<str(obj(list[j])["id"])})
    n:=len(list); credits:=make([]int,n); next:=make([]int,n); last:=make([]int,n); remaining:=0; for i,v:=range list {last[i]=-1; remaining+=len(arr(obj(v)["charges"]))}
    out:=make([]map[string]interface{},0)
    for round:=1;remaining>0;round++ {for i,v:=range list {lane:=obj(v); credits[i]=min(num(lane["cap"]),credits[i]+num(lane["refill"]))}; used:=0
      for offset:=0;offset<n&&used<num(slots);offset++{i:=(round-1+offset)%n; lane:=obj(list[i]); jobs:=arr(lane["charges"]); if next[i]==len(jobs)||last[i]==round-1||credits[i]<num(jobs[next[i]]){continue}; job:=next[i];credits[i]-=num(jobs[job]);next[i]++;last[i]=round;remaining--;used++;out=append(out,map[string]interface{}{"round":round,"lane":lane["id"],"job":job})}
    }; return out
  }`,
  'shard-fence-planner@1': `func shardFencePlanner(events, batches, shardFee interface{}) interface{} {
    list:=arr(events); n,k:=len(list),num(batches); if k>n||(n>0&&k==0){return -1}; const infinity=1<<50
    previous:=make([]int,n+1); for i:=1;i<=n;i++{previous[i]=infinity}
    for batch:=1;batch<=k;batch++{next:=make([]int,n+1);for i:=range next{next[i]=infinity}; for end:=batch;end<=n;end++{shards:=map[string]bool{}; peak:=0; for start:=end-1;start>=batch-1;start--{event:=arr(list[start]);shards[str(event[0])]=true;peak=max(peak,num(event[1]));next[end]=min(next[end],previous[start]+peak+len(shards)*num(shardFee))}};previous=next}; if previous[n]>=infinity{return -1};return previous[n]
  }`,
  'panel-notice-counters@1': `func panelNoticeCounters(events interface{}) interface{} {
    counts:=map[string]interface{}{};for _,v:=range arr(events){e:=arr(v);panel:=str(e[0]);if e[1]=="read"{counts[panel]=0}else{prior:=0;if counts[panel]!=nil{prior=counts[panel].(int)};counts[panel]=prior+1}}
    out:=make([]map[string]interface{},0);for _,panel:=range sortedKeys(counts){if counts[panel].(int)>0{out=append(out,map[string]interface{}{"panel":panel,"unread":counts[panel]})}};return out
  }`,
  'draft-revision-fold@1': `func draftRevisionFold(updates interface{}) interface{} {
    latest:=map[string]interface{}{};for _,v:=range arr(updates){update:=obj(v);id:=str(update["id"]);previous:=latest[id];if previous==nil||num(update["revision"])>num(obj(previous)["revision"]){latest[id]=update}}
    out:=make([]map[string]interface{},0);for _,id:=range sortedKeys(latest){update:=obj(latest[id]);if update["text"]!=nil{out=append(out,map[string]interface{}{"id":id,"revision":update["revision"],"text":update["text"]})}};return out
  }`,
  'viewport-anchor-walk@1': `func viewportAnchorWalk(heights, commands interface{}) interface{} {
    sizes:=make([]int,len(arr(heights)));for i,v:=range arr(heights){sizes[i]=num(v)};index,inset:=0,0;out:=make([][]int,0)
    for _,v:=range arr(commands){command:=arr(v);if command[0]=="resize"{sizes[num(command[1])]=num(command[2]);inset=min(inset,sizes[index]-1)}else{total:=0;for _,size:=range sizes{total+=size};offset:=min(max(0,num(command[1])),total-1);index=0;for offset>=sizes[index]{offset-=sizes[index];index++};inset=offset};out=append(out,[]int{index,inset})};return out
  }`,
  'focus-shortcut-tour@1': `func focusShortcutTour(panelCount, shortcuts, required interface{}) interface{} {
    n:=num(panelCount);const infinity=1<<50;distance:=make([][]int,n);for i:=range distance{distance[i]=make([]int,n);for j:=range distance[i]{if i!=j{distance[i][j]=infinity}}}
    for _,v:=range arr(shortcuts){edge:=arr(v);a,b,w:=num(edge[0]),num(edge[1]),num(edge[2]);distance[a][b]=min(distance[a][b],w)}
    for via:=0;via<n;via++{for a:=0;a<n;a++{for b:=0;b<n;b++{distance[a][b]=min(distance[a][b],distance[a][via]+distance[via][b])}}}
    nodes:=arr(required);count:=len(nodes);if count==0{if distance[0][n-1]>=infinity{return -1};return distance[0][n-1]}
    best:=make([][]int,1<<count);for mask:=range best{best[mask]=make([]int,count);for j:=range best[mask]{best[mask][j]=infinity}}
    for j,v:=range nodes{best[1<<j][j]=distance[0][num(v)]}
    for mask:=1;mask<len(best);mask++{for end:=0;end<count;end++{if mask&(1<<end)==0{continue};for next:=0;next<count;next++{if mask&(1<<next)!=0{continue};newMask:=mask|(1<<next);best[newMask][next]=min(best[newMask][next],best[mask][end]+distance[num(nodes[end])][num(nodes[next])])}}}
    answer:=infinity;for end,v:=range nodes{answer=min(answer,best[len(best)-1][end]+distance[num(v)][n-1])};if answer>=infinity{return -1};return answer
  }`,
};
export const GO_CATALOG_REFERENCES = Object.freeze(Object.fromEntries(
  Object.entries(PROGRAMS).map(([key, source]) => [key, HELPERS + source + '\n']),
));
