from playwright.sync_api import sync_playwright
from sbmock import sbmock
import json,urllib.request
res=[]
def ok(n,c):res.append(bool(c));print(("PASS " if c else "FAIL ")+n)
U="http://localhost:8765/index.html"
m=json.load(urllib.request.urlopen("http://localhost:8765/manifest.webmanifest"))
ok("manifest basics",m["display"]=="standalone" and m["start_url"]=="./" and m["id"]=="./" and len(m["shortcuts"])==3)
ok("manifest icons incl maskable",{i["purpose"] for i in m["icons"]}=={"any","maskable"} and all(urllib.request.urlopen("http://localhost:8765/"+i["src"]).status==200 for i in m["icons"]))
with sync_playwright() as p:
  b=p.chromium.launch();ctx=b.new_context(viewport={'width':390,'height':900},service_workers="allow");pg=ctx.new_page();errs=[];pg.on("pageerror",lambda e:errs.append(str(e)))
  pg.route("**/*.js",lambda r:r.continue_() if "localhost" in r.request.url else r.fulfill(body="",content_type="application/javascript"))
  pg.add_init_script(sbmock("admin"))
  pg.goto(U);pg.wait_for_timeout(1500)
  ok("service worker active",pg.evaluate("navigator.serviceWorker.getRegistration().then(r=>!!(r&&r.active))"))
  keys=pg.evaluate("caches.keys().then(async ks=>{const c=await caches.open(ks[0]);return (await c.keys()).map(r=>new URL(r.url).pathname)})")
  ok("shell precached",all(x in keys for x in ["/index.html","/manifest.webmanifest","/icon-512.png","/icon-maskable-512.png","/apple-touch-icon.png"]))
  ok("apple-touch-icon linked",pg.evaluate("document.querySelector('link[rel=apple-touch-icon]').getAttribute('href')")=="apple-touch-icon.png")
  # install card
  pg.click("#t5");pg.wait_for_timeout(400)
  ok("install card with manual steps (no prompt yet)","تثبيت التطبيق على الموبايل" in pg.inner_text("#view") and pg.locator("#app_i").count()==0)
  pg.evaluate("window.__pr=0;const e=new Event('beforeinstallprompt');e.prompt=()=>{window.__pr++};e.userChoice=Promise.resolve({outcome:'accepted'});window.dispatchEvent(e)");pg.wait_for_timeout(400)
  ok("install button appears on beforeinstallprompt",pg.locator("#app_i").count()==1)
  pg.click("#app_i");pg.wait_for_timeout(300);ok("prompt called and button removed",pg.evaluate("window.__pr")==1 and pg.locator("#app_i").count()==0)
  # offline
  ctx.set_offline(True);pg.wait_for_timeout(200)
  ok("offline banner",("لا يوجد اتصال" in pg.inner_text("#warn")))
  pg2=ctx.new_page();pg2.route("**/*.js",lambda r:r.continue_() if "localhost" in r.request.url else r.fulfill(body="",content_type="application/javascript"))
  r=pg2.goto(U);ok("app shell opens offline",r is not None and "Biosyn CRM" in pg2.title())
  ctx.set_offline(False);pg.wait_for_timeout(200);ok("banner hides when back online",not pg.is_visible("#warn"))
  ok("no js errors",not errs);print(errs)
print(sum(res),"/",len(res))
