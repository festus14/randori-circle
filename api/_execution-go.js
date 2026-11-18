// Go uses two files in one fresh Piston sandbox. Submissions keep their own
// package/import declarations; the server owns main and the result framing.
// Reflection decodes JSON directly to the entrypoint's declared Go types.
export function buildGoHarness(userCode, testSuite, resultPrefix) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(testSuite.entrypoint)) throw new TypeError('invalid Go entrypoint');
  const cases = JSON.stringify(testSuite.tests.map(test => test.args));
  const encoded = Buffer.from(cases).toString('base64');
  const harness = `package main
import (
  randoriBase64 "encoding/base64"
  randoriJson "encoding/json"
  randoriFmt "fmt"
  randoriReflect "reflect"
)
func randoriCase(fn randoriReflect.Value, args []randoriJson.RawMessage) (got interface{}, ok bool, problem interface{}) {
  returned:=false
  defer func() { if failure:=recover(); failure!=nil || !returned { got=nil; ok=false; problem="runtime error" } }()
  kind:=fn.Type()
  if kind.IsVariadic() || kind.NumIn()!=len(args) || kind.NumOut()!=1 { return nil,false,"runtime error" }
  values:=make([]randoriReflect.Value,len(args))
  for index, raw:=range args {
    value:=randoriReflect.New(kind.In(index))
    if randoriJson.Unmarshal(raw,value.Interface())!=nil { return nil,false,"runtime error" }
    values[index]=value.Elem()
  }
  got=fn.Call(values)[0].Interface()
  if _,err:=randoriJson.Marshal(got); err!=nil { return nil,false,"runtime error" }
  returned=true
  return got,true,nil
}
func main() {
  data,_:=randoriBase64.StdEncoding.DecodeString(${JSON.stringify(encoded)})
  var cases [][]randoriJson.RawMessage
  if randoriJson.Unmarshal(data,&cases)!=nil { return }
  fn:=randoriReflect.ValueOf(${testSuite.entrypoint})
  for index,args:=range cases {
    got,ok,problem:=randoriCase(fn,args)
    row:=map[string]interface{}{"idx":index,"ok":ok,"got":got,"error":problem}
    output,err:=randoriJson.Marshal(row)
    if err!=nil { continue }
    randoriFmt.Println(${JSON.stringify(resultPrefix)}+string(output))
  }
}
`;
  return Object.freeze({ harness, submission: String(userCode) });
}
