import * as P from "/home/claude/biosyn-crm/supabase/functions/pay-webhook/pay.ts";
import crypto from "node:crypto";
let fails=0;const ok=(n:string,c:boolean)=>{console.log((c?"PASS ":"FAIL ")+n);if(!c)fails++};
// Stripe
const raw=JSON.stringify({id:"evt_1",type:"checkout.session.completed",data:{object:{id:"cs_1",payment_status:"paid",amount_total:12345,payment_intent:"pi_1",metadata:{txn_id:"tabc"}}}});
const t=Math.floor(Date.now()/1000);const sig=crypto.createHmac("sha256","whsec_x").update(`${t}.${raw}`).digest("hex");
ok("stripe valid sig",await P.verifyStripe(raw,`t=${t},v1=${sig}`,"whsec_x"));
ok("stripe bad sig",!(await P.verifyStripe(raw,`t=${t},v1=${sig.replace(/.$/,"0")}`,"whsec_x"))||sig.endsWith("0"));
ok("stripe wrong secret",!(await P.verifyStripe(raw,`t=${t},v1=${sig}`,"whsec_y")));
ok("stripe old timestamp",!(await P.verifyStripe(raw,`t=${t-1000},v1=${crypto.createHmac("sha256","whsec_x").update(`${t-1000}.${raw}`).digest("hex")}`,"whsec_x")));
const sp=P.stripePaid(JSON.parse(raw));ok("stripe paid parse",sp.paid&&sp.txn==="tabc"&&sp.amount===123.45&&sp.ref==="pi_1");
ok("stripe unpaid not paid",!P.stripePaid({type:"checkout.session.completed",data:{object:{payment_status:"unpaid",metadata:{txn_id:"x"}}}}).paid);
ok("stripe form amount in piasters",P.stripeForm({amount:250.5,name:"باقة",txn:"t1",success:"s",cancel:"c"}).get("line_items[0][price_data][unit_amount]")==="25050");
// Paymob
const obj={amount_cents:50000,created_at:"2026-10-27T10:00:00.000000",currency:"EGP",error_occured:false,has_parent_transaction:false,id:777,integration_id:123,is_3d_secure:true,is_auth:false,is_capture:false,is_refunded:false,is_standalone_payment:true,is_voided:false,order:{id:999,merchant_order_id:"t9~abc"},owner:55,pending:false,source_data:{pan:"2346",sub_type:"MasterCard",type:"card"},success:true};
const str=P.paymobString(obj);ok("paymob concat order",str==="500002026-10-27T10:00:00.000000EGPfalsefalse777123truefalsefalsefalsetruefalse99955false2346MasterCardcardtrue");
const h=crypto.createHmac("sha512","pmsecret").update(str).digest("hex");
ok("paymob valid hmac",await P.verifyPaymob(obj,h,"pmsecret"));ok("paymob wrong secret",!(await P.verifyPaymob(obj,h,"other")));
ok("paymob tampered amount",!(await P.verifyPaymob({...obj,amount_cents:1},h,"pmsecret")));
const pp=P.paymobPaid(obj);ok("paymob paid parse",pp.paid&&pp.txn==="t9"&&pp.amount===500&&pp.ref==="777");
ok("paymob failed not paid",!P.paymobPaid({...obj,success:false}).paid&&!P.paymobPaid({...obj,pending:true}).paid&&!P.paymobPaid({...obj,is_refunded:true}).paid);
const pi=P.paymobIntention({amount:500,name:"باقة سنوية",txn:"t9",contact:{name:"منى أحمد سالم"},integrations:[1,2],notify:"n",redirect:"r"});
ok("paymob intention",pi.amount===50000&&pi.special_reference.startsWith("t9~")&&pi.billing_data.last_name==="أحمد سالم"&&pi.extras.txn_id==="t9");
ok("template fill",P.fillTemplate("https://p.x/?a={المبلغ}&r={المرجع}&n={الاسم}",{amount:"100",ref:"t 1",name:"منى",email:"",phone:"",item:""})==="https://p.x/?a=100&r=t%201&n=%D9%85%D9%86%D9%89");
console.log(fails?fails+" FAILED":"ALL OK");process.exit(fails?1:0)
