export const store:any={gateway_secrets:[],payment_events:[],txns:[],contacts:[]};
class Q{t:string;f:any[]=[];op="select";patch:any=null;constructor(t:string){this.t=t}
 select(_c?:string){return this} eq(k:string,v:any){this.f.push([k,v]);return this}
 insert(o:any){const rows=store[this.t];if(this.t==="payment_events"&&rows.some((r:any)=>r.id===o.id))return Promise.resolve({error:{message:"dup"}});rows.push({...o});return Promise.resolve({error:null})}
 update(p:any){this.op="update";this.patch=p;return this}
 match(){return store[this.t].filter((r:any)=>this.f.every(([k,v]:any)=>r[k]===v))}
 maybeSingle(){const m=this.match();return Promise.resolve({data:m[0]||null,error:null})}
 then(res:any){if(this.op==="update"){this.match().forEach((r:any)=>Object.assign(r,this.patch));return Promise.resolve({error:null}).then(res)}return Promise.resolve({data:this.match(),error:null}).then(res)}}
export const createClient=(..._a:any[])=>({from:(t:string)=>new Q(t)});export type SupabaseClient=any;
