import re,json,subprocess,sys
SRC=subprocess.check_output(['git','-C','/home/claude/biosyn-crm','show','HEAD:index.html']).decode('utf8')
d={}
for f in ['d1','d2','d3','d4','d5']:
    try: lines=open(f'/home/claude/i18n/{f}.txt',encoding='utf8').read().rstrip('\n').split('\n')
    except FileNotFoundError: continue
    for l in lines:
        p=l.split('|'); assert len(p)==3,(f,l)
        d[p[0]]=(p[1] or p[0],p[2])
RUN=re.compile(r'[؀-ۿ][؀-ۿ‏ ,،:؟?!.\-/()&;·%0-9]*[؀-ۿ؟?!:)]|[؀-ۿ]')
miss=sorted(set(RUN.findall(SRC))-set(d))
if miss: print('MISSING',miss); sys.exit(1)
REG=re.compile(r'(?<![<\w)\]"\'])/(?:\\.|[^/\n\\])*[؀-ۿ](?:\\.|[^/\n\\])*/[gimsuy]*(?=[.,;)\s:])')
PROT={238,306,320,322,333,993,1115}
out=[]
for i,line in enumerate(SRC.split('\n'),1):
    keep=[]
    if i in PROT:
        def mk(m):
            keep.append(m.group(0)); return '\x00%d\x00'%(len(keep)-1)
        line=REG.sub(mk,line)
    line=RUN.sub(lambda m:d[m.group(0)][0],line)
    for j,k in enumerate(keep): line=line.replace('\x00%d\x00'%j,k)
    out.append(line)
S='\n'.join(out)
# ---- locale
S=S.replace('"ar-EG"','LOC')
# ---- head script + css
S=S.replace('<meta charset="utf-8">','<meta charset="utf-8"><script>try{if(localStorage.getItem("bl")==="en"||window.name==="bl-en"){document.documentElement.lang="en";document.documentElement.dir="ltr"}}catch(e){}</script>',1)
S=S.replace('</style></head>','html[dir=ltr] .gsb{float:right}html[dir=ltr] th,html[dir=ltr] td{text-align:left}html[dir=ltr] .rep td,html[dir=ltr] .rep th{text-align:left}.lgb{font-size:12px;padding:3px 10px;margin-inline-start:8px;cursor:pointer}</style></head>',1)
# ---- header button
S=S.replace('<button class="gsb" id="gs"','<button class="gsb lgb" id="lng" onclick="setLang()"></button><button class="gsb" id="gs"',1)
# login button
LH_OLD="const LH='<h2 style=\"margin:0 0 6px;font-size:20px;text-align:center\">Biosyn <span style=\"color:var(--ac)\">CRM</span></h2>';"
assert LH_OLD in S
S=S.replace(LH_OLD,"const LH='<div style=\"text-align:center\"><button class=\"lgb\" type=\"button\" onclick=\"setLang()\">'+LNG_LBL+'</button></div><h2 style=\"margin:0 0 6px;font-size:20px;text-align:center\">Biosyn <span style=\"color:var(--ac)\">CRM</span></h2>';")
# ---- exports
S=S.replace("const ws=XLSX.utils.aoa_to_sheet([sh.H,...sh.R]);","sh={...sh,name:tr(sh.name),H:sh.H.map(tr),R:sh.R.map(r=>r.map(trx))};const ws=XLSX.utils.aoa_to_sheet([sh.H,...sh.R]);",1)
S=S.replace("wb.Workbook={Views:[{RTL:true}]};","wb.Workbook={Views:[{RTL:LANG!==\"en\"}]};",1)

S=S.replace('.map(r=>r.map(q).join(","))','.map(r=>r.map(x=>q(trx(x))).join(","))')
S=S.replace("sh.H.map(tr)","sh.H.map(trx)")
S=S.replace('const to=prompt(','const to=prompt(')  # prompt wrapped at runtime
# ---- English dictionary keyed by rendered (MSA) text; originals added as fallbacks
EN={}
for k,(m,e) in d.items(): EN.setdefault(m,e)
for k,(m,e) in d.items(): EN.setdefault(k,e)
js=json.dumps(EN,ensure_ascii=False,separators=(',',':'))
RT=r"""
const LANG=(()=>{try{if(localStorage.getItem("bl")==="en")return"en"}catch(e){}return window.name==="bl-en"?"en":"ar"})(),LOC=LANG==="en"?"en-GB":"ar-EG",LNG_LBL=LANG==="en"?"العربية":"English";
const EN=__EN__;
const RUNX=/[؀-ۿ][؀-ۿ‏ ,،:؟?!.\-\/()&;·%0-9]*[؀-ۿ؟?!:)]|[؀-ۿ]/g,ENK=Object.keys(EN).filter(k=>k.length>1).sort((a,b)=>b.length-a.length);
const SEGC=new Map(),AL=/[؀-ۿ]/;
function seg(m){
 if(SEGC.has(m))return SEGC.get(m);
 let r=null;
 if(EN[m]!==undefined&&(m.length>2||false))r=EN[m];
 else{
  const n=m.length,best=new Array(n+1).fill(null);best[0]="";
  for(let i=0;i<n;i++){
   if(best[i]===null)continue;
   const c=m[i];
   if(!AL.test(c)&&c!==" "||c===" "){if(best[i+1]===null)best[i+1]=best[i]+c;}
   if(i>0&&AL.test(m[i-1])&&AL.test(c))continue;
   for(const k of ENK){
    if(k.length>n-i||!m.startsWith(k,i))continue;
    const e=i+k.length;
    if(e<n&&AL.test(m[e-1])&&AL.test(m[e]))continue;
    if(best[e]===null||best[i]!==null)best[e]=best[i]+EN[k];
   }
  }
  r=best[n]}
 SEGC.set(m,r);return r}
function trEn(s){
 if(typeof s!=="string"||!AL.test(s))return s;
 const t=s.trim();
 if(s.includes("{الاسم}"))return s.split("{الاسم}").map(tr).join("{الاسم}");
 s=s.replace(/(\d) ج(?![؀-ۿ])/g,"$1 EGP").replace(/(\d) د(?![؀-ۿ])/g,"$1 min").replace(/(\d) س(?![؀-ۿ])/g,"$1 h");
 s=s.replace(RUNX,m=>{
  if(m.length<=2)return m===t&&EN[m]!==undefined?EN[m]:(EN[m]!==undefined&&m.length===2?EN[m]:m);
  if(EN[m]!==undefined)return EN[m];
  return m.split(/([(),،:·;؟?!.\-\/&%\d]+)/).map(p=>{if(!AL.test(p)||p.length<2)return p;const lead=p.match(/^\s*/)[0],tail=p.match(/\s*$/)[0],c=p.trim(),r=seg(c);return r===null?p:lead+r+tail}).join("")});
 return s.replace(/،/g,",").replace(/؟/g,"?")}
const ARX=__ARX__,ARK=Object.keys(ARX).sort((a,b)=>b.length-a.length);
function trAr(s){if(typeof s!=="string"||!AL.test(s))return s;for(const k of ARK)if(s.includes(k))s=s.split(k).join(ARX[k]);return s}
const tr=s=>LANG==="en"?trEn(s):trAr(s);
const trx=v=>(LANG==="en"&&typeof v==="string"&&EN[v]!==undefined)?EN[v]:v;
function setLang(){const n=LANG==="en"?"ar":"en";try{localStorage.setItem("bl",n)}catch(e){}window.name=n==="en"?"bl-en":"";location.reload()}
if(LANG==="en"){document.documentElement.lang="en";document.documentElement.dir="ltr"}
{
 const _a=window.alert,_c=window.confirm,_p=window.prompt;
 window.alert=m=>_a(tr(String(m)));window.confirm=m=>_c(tr(String(m)));window.prompt=(m,v)=>_p(tr(String(m)),v);
 const SK={SCRIPT:1,STYLE:1,TEXTAREA:1,INPUT:1,CODE:1},AT=["placeholder","title","aria-label","alt"];
 const trAttr=e=>AT.forEach(a=>{const v=e.getAttribute&&e.getAttribute(a);if(v){const o=tr(v);if(o!==v)e.setAttribute(a,o)}});
 const one=n=>{
  if(n.nodeType===3){const v=n.nodeValue,p=n.parentNode;if(p&&!SK[p.nodeName]&&/[؀-ۿ،؟]/.test(v)){const o=tr(v);if(o!==v)n.nodeValue=o}}
  else if(n.nodeType===1){if(LANG==="en"&&n.nodeName==="OPTION"&&!n.hasAttribute("value"))n.setAttribute("value",n.textContent);trAttr(n)}};
 const walk=r=>{one(r);if(r.nodeType!==1&&r.nodeType!==11)return;const w=document.createTreeWalker(r,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode()){one(n)}};
 new MutationObserver(ms=>{for(const m of ms){if(m.type==="childList")m.addedNodes.forEach(walk);else if(m.type==="characterData")one(m.target);else trAttr(m.target)}}).observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:AT});
 document.title=document.title;walk(document.body);
}
$("lng")&&($("lng").textContent=LNG_LBL);
"""
d5=set()
for l in open('/home/claude/i18n/d5.txt',encoding='utf8').read().rstrip('\n').split('\n'): d5.add(l.split('|')[0])
ARX={k:d[k][0] for k in d5 if d[k][0]!=k and len(k)>=8}
for k in ["اتدمج معاه:","اتضاف من محادثة","اتغيّر:","اتعمل حساب","اتسندت لك المحادثة دي"]: ARX[k]=d[k][0]
RT=RT.replace('__ARX__',json.dumps(ARX,ensure_ascii=False,separators=(',',':')))
RT=RT.replace('__EN__',js)
# insert before ST const; $ is defined at line "const $=" so insert after esc def
import re as _re
mm=_re.search(r'^const esc=.*$',S,_re.M); assert mm
S=S[:mm.end()]+RT+S[mm.end():]
open('/home/claude/i18n/stage1.html','w',encoding='utf8').write(S)
print('built',len(S))
