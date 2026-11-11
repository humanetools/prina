/**
 * Client runtimes (T5.2 modes ②③ + T5.4)
 * - fragment inline runtime: view push + data-ga-event click push when attached via SSR
 * - embed.js: Shadow DOM render + directly pushes shadow-internal clicks GTM cannot see (§2.4)
 */

/** Runtime inlined into the fragment — runs when SSR-embedded in the customer's page (mode ②) */
export function fragmentRuntime(rootId: string): string {
  return `
(function(){
  var root=document.getElementById(${JSON.stringify(rootId)});
  if(!root||root.dataset.prinaGaBound)return;
  root.dataset.prinaGaBound="1";
  var cfgEl=root.querySelector('script.prina-ga-config');
  if(!cfgEl)return;
  var cfg=JSON.parse(cfgEl.textContent||"{}");
  window.dataLayer=window.dataLayer||[];
  if(cfg.containerId&&window.google_tag_manager&&!window.google_tag_manager[cfg.containerId]){
    console.warn('prina: this page was served for GTM '+cfg.containerId+' but that container is not installed — currency may not match');
  }
  [].concat(cfg.view||[]).forEach(function(v){window.dataLayer.push(v);});
  root.addEventListener('click',function(ev){
    var el=ev.target&&ev.target.closest?ev.target.closest('[data-ga-event]'):null;
    if(!el||!root.contains(el))return;
    var p=cfg.click&&cfg.click[el.getAttribute('data-ga-event')];
    if(p)window.dataLayer.push(p);
  });
})();`.trim();
}

/**
 * embed.js (mode ③) — one-line snippet:
 * <script src=".../delivery/embed.js" data-type="product" data-id="<entryId>" defer></script>
 * Shadow DOM isolates from host CSS. GTM's auto click trigger cannot see inside the shadow,
 * so we push to window.dataLayer directly here.
 */
export function embedJsSource(): string {
  return `
(function(){
  var me=document.currentScript;
  if(!me)return;
  var type=me.getAttribute('data-type'),id=me.getAttribute('data-id');
  if(!type||!id)return;
  var wantHead=me.getAttribute('data-prina-head')==='1';
  var base=new URL(me.src).origin;
  var ws=me.getAttribute('data-workspace')||'default';
  var host=document.createElement('div');
  host.setAttribute('data-prina-embed',type);
  me.parentNode.insertBefore(host,me);
  var shadow=host.attachShadow({mode:'open'});
  fetch(base+'/delivery/'+encodeURIComponent(type)+'/'+encodeURIComponent(id)+'?format=html&embed=1&ws='+encodeURIComponent(ws))
    .then(function(r){if(!r.ok)throw new Error('prina embed: '+r.status);return r.json();})
    .then(function(data){
      var wrap=document.createElement('div');
      if(data.css){var st=document.createElement('style');st.textContent=data.css;shadow.appendChild(st);}
      wrap.innerHTML=data.html;
      shadow.appendChild(wrap);
      window.dataLayer=window.dataLayer||[];
      var cfg=data.ga||{};
      if(cfg.containerId&&window.google_tag_manager&&!window.google_tag_manager[cfg.containerId]){
        console.warn('prina: served for GTM '+cfg.containerId+' but that container is not installed');
      }
      [].concat(cfg.view||[]).forEach(function(v){window.dataLayer.push(v);});
      wrap.addEventListener('click',function(ev){
        var path=ev.composedPath?ev.composedPath():[ev.target];
        for(var i=0;i<path.length;i++){
          var el=path[i];
          if(el&&el.getAttribute&&el.getAttribute('data-ga-event')){
            var p=cfg.click&&cfg.click[el.getAttribute('data-ga-event')];
            if(p)window.dataLayer.push(p);
            return;
          }
        }
      });
      if(data.js){
        try{new Function('root',data.js)(wrap);}catch(e){console.error('prina embed script:',e);}
      }
      // Host <head> promotion — strictly opt-in via data-prina-head="1" (embeds must not hijack host pages)
      if(wantHead){
        if(data.seo){
          if(data.seo.title)document.title=data.seo.title;
          if(data.seo.head)document.head.insertAdjacentHTML('beforeend',data.seo.head);
        }
        if(data.jsonld){
          var ld=document.createElement('script');
          ld.type='application/ld+json';
          ld.textContent=JSON.stringify(data.jsonld);
          document.head.appendChild(ld);
        }
      }
    })
    .catch(function(e){console.error(e);});
})();`.trim();
}
