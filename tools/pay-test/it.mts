import crypto from "node:crypto";
let handler:any;(globalThis as any).Deno={serve(h:any){handler=h},env:{get(){return "https://x.supabase.co"}}};
const {store}=await import("./stub.ts");await import("./pay-webhook/index.ts");
let fails=0;const ok=(n:string,c:boolean)=>{console.log((c?"PASS ":"FAIL ")+n);if(!c)fails++};
const today=new Intl.DateTimeFormat("sv-SE",{timeZone:"Africa/Cairo"}).format(new Date());
function reset(){store.txns=[{id:"t1",data:{kind:"in",amt:1200,date:"2026-10-01",cat:"باقة اشتراك",item:"باقة سنوية",status:"pending",con:"c1"}},{id:"t2",data:{kind:"in",amt:300,date:"2026-10-01",cat:"باقة اشتراك",item:"باقة سنوية",status:"pending",con:"c1",inst:{g:"g",n:2,of:4,due:"2026-11-01"}}}];
 store.contacts=[{id:"c1",data:{name:"منى",stage:"lead",log:[]}}];store.payment_events=[];
 store.gateway_secrets=[{provider:"stripe",enabled:true,config:{webhook_secret:"whsec_t"}},{provider:"paymob",enabled:true,config:{hmac_secret:"pmsec"}},{provider:"custom",enabled:true,config:{secret:"cs"}}]}
const call=async(path:string,body:string,h:Record<string,string>={})=>{const r=await handler(new Request("https://x/functions/v1/pay-webhook"+path,{method:"POST",body,headers:h}));return {s:r.status,j:await r.json()}};
const stripeEv=(id:string,txn:string,amt:number)=>{const raw=JSON.stringify({id,type:"checkout.session.completed",data:{object:{id:"cs",payment_status:"paid",amount_total:amt*100,payment_intent:"pi",metadata:{txn_id:txn}}}});const t=Math.floor(Date.now()/1000);return {raw,h:{"stripe-signature":`t=${t},v1=${crypto.createHmac("sha256","whsec_t").update(`${t}.${raw}`).digest("hex")}`}}};
reset();let e=stripeEv("evt1","t1",1200);let r=await call("/stripe",e.raw,e.h);
ok("stripe paid 200",r.s===200&&r.j.paid===true);
ok("txn marked paid + date + method",store.txns[0].data.status==="paid"&&store.txns[0].data.date===today&&store.txns[0].data.method==="بطاقة / بوابة دفع"&&store.txns[0].data.pay.provider==="stripe");
ok("contact promoted & expiry extended 12 months",store.contacts[0].data.stage==="member"&&!!store.contacts[0].data.exp&&store.contacts[0].data.exp>today);
r=await call("/stripe",e.raw,e.h);ok("replay is duplicate (no double processing)",r.j.duplicate===true&&store.payment_events.filter((x:any)=>x.status==="paid").length===1);
reset();e=stripeEv("evt2","t1",5);r=await call("/stripe",e.raw,e.h);ok("amount mismatch not marked paid",r.j.mismatch===true&&store.txns[0].data.status==="pending");
reset();e=stripeEv("evt3","nope",1200);r=await call("/stripe",e.raw,e.h);ok("unknown txn -> unmatched",r.j.unmatched===true);
reset();e=stripeEv("evt4","t1",1200);r=await call("/stripe",e.raw,{"stripe-signature":"t=1,v1=bad"});ok("bad stripe signature 401",r.s===401&&store.txns[0].data.status==="pending");
reset();e=stripeEv("evt5","t2",300);r=await call("/stripe",e.raw,e.h);ok("installment paid, no expiry bump",r.j.paid===true&&store.contacts[0].data.exp===undefined&&store.contacts[0].data.log[0].x.includes("قسط 2/4"));
// paymob
const pm=(obj:any,secret="pmsec")=>{const keys=["amount_cents","created_at","currency","error_occured","has_parent_transaction","id","integration_id","is_3d_secure","is_auth","is_capture","is_refunded","is_standalone_payment","is_voided","order.id","owner","pending","source_data.pan","source_data.sub_type","source_data.type","success"];const dig=(o:any,p:string)=>p.split(".").reduce((a:any,k)=>a==null?a:a[k],o);return crypto.createHmac("sha512",secret).update(keys.map(k=>{const v=dig(obj,k);return v==null?"":String(v)}).join("")).digest("hex")};
const obj={amount_cents:120000,created_at:"x",currency:"EGP",error_occured:false,has_parent_transaction:false,id:55,integration_id:1,is_3d_secure:true,is_auth:false,is_capture:false,is_refunded:false,is_standalone_payment:true,is_voided:false,order:{id:9,merchant_order_id:"t1~zz"},owner:1,pending:false,source_data:{pan:"1",sub_type:"V",type:"card"},success:true};
reset();r=await call("/paymob?hmac="+pm(obj),JSON.stringify({type:"TRANSACTION",obj}));ok("paymob paid",r.s===200&&r.j.paid===true&&store.txns[0].data.status==="paid");
reset();r=await call("/paymob?hmac="+pm(obj,"wrong"),JSON.stringify({type:"TRANSACTION",obj}));ok("paymob bad hmac 401",r.s===401&&store.txns[0].data.status==="pending");
reset();r=await call("/paymob?hmac="+pm({...obj,success:false}),JSON.stringify({type:"TRANSACTION",obj:{...obj,success:false}}));ok("paymob failed payment ignored",r.j.ignored==="not paid"&&store.txns[0].data.status==="pending");
// custom
reset();r=await call("/custom",JSON.stringify({txn_id:"t1",status:"paid",amount:1200}),{"x-pay-secret":"cs"});ok("custom paid",r.j.paid===true);
reset();r=await call("/custom",JSON.stringify({txn_id:"t1",status:"paid"}),{"x-pay-secret":"no"});ok("custom wrong secret 401",r.s===401);
reset();r=await call("/custom?s=cs",JSON.stringify({ref:"t1",status:"failed"}));ok("custom non-paid status ignored",r.j.ignored==="failed"&&store.txns[0].data.status==="pending");
reset();store.gateway_secrets[0].enabled=false;e=stripeEv("evt9","t1",1200);r=await call("/stripe",e.raw,e.h);ok("disabled gateway rejected",r.s===403);
console.log(fails?fails+" FAILED":"ALL OK");process.exit(fails?1:0)
