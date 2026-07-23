/* ================================================================
   live-overlay-service.js v3 — Eyad_Eyad12
   أوفرلي البث المباشر — ربط تلقائي بببجي موبايل
   3 طرق: OCR لقطة شاشة + PUBG API + يدوي
================================================================ */

const LO_KEY   = 'pubg_live_eyad12';
const LO_CH    = 'pubg-live-eyad12';
let LO_PLACEMENT = [0,12,9,7,5,4,3,2,1,1,1,0,0,0,0,0,0,0,0,0,0,0];
/* رموز أعلام الدول (ISO) — تُستخدم لعرض العلم كصورة حقيقية بالأوفرلي بدل الإيموجي،
   لأن إيموجي العلم المركّب (مثل 🇸🇦) ينكسر ويطلع كنص "SA" بويندوز/OBS (CEF) بدل الصورة الملونة */
const LO_FLAGS=[
    {code:'none',emoji:'🏳️',label:'بدون علم'},
    {code:'iq',emoji:'🇮🇶',label:'العراق'},
    {code:'sa',emoji:'🇸🇦',label:'السعودية'},
    {code:'ae',emoji:'🇦🇪',label:'الإمارات'},
    {code:'kw',emoji:'🇰🇼',label:'الكويت'},
    {code:'qa',emoji:'🇶🇦',label:'قطر'},
    {code:'bh',emoji:'🇧🇭',label:'البحرين'},
    {code:'om',emoji:'🇴🇲',label:'عُمان'},
    {code:'jo',emoji:'🇯🇴',label:'الأردن'},
    {code:'eg',emoji:'🇪🇬',label:'مصر'},
    {code:'sy',emoji:'🇸🇾',label:'سوريا'},
    {code:'ma',emoji:'🇲🇦',label:'المغرب'},
    {code:'tr',emoji:'🇹🇷',label:'تركيا'},
    {code:'de',emoji:'🇩🇪',label:'ألمانيا'},
    {code:'gb',emoji:'🇬🇧',label:'بريطانيا'},
    {code:'us',emoji:'🇺🇸',label:'أمريكا'},
    {code:'br',emoji:'🇧🇷',label:'البرازيل'},
];
/* يحوّل قيم علم قديمة (إيموجي محفوظ من نسخة سابقة) لكود الدولة الجديد */
function loMigrateFlag(v){
    if(!v||v==='🏳️') return 'none';
    const found=LO_FLAGS.find(f=>f.emoji===v);
    return found?found.code:(LO_FLAGS.some(f=>f.code===v)?v:'none');
}

let loTeams=[], loBc=null, loNextId=1;
let loEliminationOrder=[];
let loAutoMode='manual';   /* manual | ocr | api */
let loAutoTimer=null;
let loApiKey='', loPlayerName='', loLastMatchId='';
let loKillLockTid=null, loKillLockUntil=0;      /* منع الضغط الخاطئ على فريق آخر بعد إضافة نقطة */
let loColVis={rank:1,elim:1,name:1,abbr:1,players:1,kills:1,place:1,total:1,logo:1,color:1,flag:1};
let loBgSettings={headerBg:null,bodyBg:null,elimBannerBg:null,killCardBg:null};   /* {type:'image'|'video', data:base64} */
let loScanStream=null, loScanRegion=null, loScanTimer=null, loScanActive=false;
let loPendingKill=null; /* {killerTid, victimTid, victimPi} بانتظار تأكيد */
let loOcrAutoApply=true;         /* تطبيق تلقائي فوري بدون تأكيد يدوي — الافتراضي الآن */
let loScanIntervalMs=3000;        /* كل چم مللي ثانية يصير مسح جديد */
let loSeenEvents=[];               /* [{key,ts}] لمنع تكرار تطبيق نفس الحدث لو ظل ظاهر بكذا مسحة متتالية */
let loPendingKillQueue=[];         /* بوضع التأكيد اليدوي — طابور بدل ما ينمسح بعضه */
let loPendingKillShowing=false;
let loPendingKillToken=0;
let loScanMode='killfeed';         /* killfeed = يراقب سطر قتل واحد | board = يقرأ لوحة كل الفرق كاملة كل مسحة */
let loLastBoardSnapshot=null;      /* نسخة احتياطية من حالة الفرق قبل آخر مزامنة شاملة (لدعم التراجع) */
let loElimBannerCfg={xPct:50,yPct:50,scale:1}; /* مكان حر (نسبة%) وحجم بانر الإقصاء */
let loSpotlightCfg={enabled:true,triggerCount:5,cycles:3}; /* عرض الفرق المتبقية الدوّار */
let loTeamElimBg={}; /* {tid: {type,data}} خلفية إقصاء خاصة لكل فريق */

/* ════════════════════════════════════════════════
   IndexedDB — تخزين الصور/الفيديوهات (بدلاً من localStorage)
   localStorage محدود بـ 5-10MB فقط، وأي فيديو يتجاوزه يفشل بصمت
   ويكسر loBroadcast() بالكامل (يمنع فتح OBS وإرسال أي تحديث لاحق،
   بما فيها إشعار الإقصاء). IndexedDB يتحمل مئات الميجا بأمان.
════════════════════════════════════════════════ */
const LO_DB_NAME='lo_media_store', LO_DB_STORE='media';
function loIdbOpen(){
    return new Promise((resolve,reject)=>{
        const req=indexedDB.open(LO_DB_NAME,1);
        req.onupgradeneeded=()=>{ if(!req.result.objectStoreNames.contains(LO_DB_STORE)) req.result.createObjectStore(LO_DB_STORE); };
        req.onsuccess=()=>resolve(req.result);
        req.onerror=()=>reject(req.error);
    });
}
async function loIdbSet(key,value){
    const db=await loIdbOpen();
    return new Promise((resolve,reject)=>{
        const tx=db.transaction(LO_DB_STORE,'readwrite');
        tx.objectStore(LO_DB_STORE).put(value,key);
        tx.oncomplete=()=>resolve();
        tx.onerror=()=>reject(tx.error);
    });
}
async function loIdbGet(key){
    const db=await loIdbOpen();
    return new Promise((resolve,reject)=>{
        const tx=db.transaction(LO_DB_STORE,'readonly');
        const req=tx.objectStore(LO_DB_STORE).get(key);
        req.onsuccess=()=>resolve(req.result||null);
        req.onerror=()=>reject(req.error);
    });
}
async function loIdbDelete(key){
    const db=await loIdbOpen();
    return new Promise((resolve,reject)=>{
        const tx=db.transaction(LO_DB_STORE,'readwrite');
        tx.objectStore(LO_DB_STORE).delete(key);
        tx.oncomplete=()=>resolve();
        tx.onerror=()=>reject(tx.error);
    });
}

/* ════════════════════════════════════════════════
   Firebase Storage — رفع الخلفيات (صور/فيديو) عشان توصل لأي جهاز ثاني
   IndexedDB (فوق) يبقى مصدر محلي سريع لنفس الجهاز، وهذا يضيف نسخة على
   الإنترنت (رابط صغير) تنبعث عبر Realtime Database لأي جهاز ثاني مفتوح
   عليه أوفرلي/OBS بمكان آخر.
════════════════════════════════════════════════ */
async function loUploadBgToStorage(file,path){
    if(!window.loFirebase?.storage) throw new Error('Firebase Storage غير متاح (تأكد إنك متصل بالنت)');
    const {storage,sRef,uploadBytes,getDownloadURL}=window.loFirebase;
    const fileRef=sRef(storage,path);
    await uploadBytes(fileRef,file);
    return await getDownloadURL(fileRef);
}

/* ترحيل بيانات اللاعبين القديمة (نص فقط) لصيغة كائن {name,status} */
function loMigratePlayers(t){
    if(!Array.isArray(t.players)) t.players=[];
    t.players=Array.from({length:4},(_,i)=>{
        const p=t.players[i];
        if(typeof p==='string') return {name:'',status:p};
        if(p&&typeof p==='object') return {name:p.name||'',status:p.status||'alive'};
        return {name:'',status:'alive'};
    });
    return t;
}

/* ════ Patch openService ════ */
(function(){
    const prev=window.openService;
    window.openService=function(id,name){
        if(id!=='live-overlay') return prev?.call(this,id,name);
        const modal=document.getElementById('serviceModal');
        const title=document.getElementById('serviceModalTitle');
        const cont =document.getElementById('serviceModalContent');
        if(!modal||!title||!cont) return;
        title.textContent=name;
        cont.innerHTML=loHTML();
        modal.classList.add('active');
        requestAnimationFrame(loInit);
    };
})();

/* ════════════════════════════════════════════════
   HTML
════════════════════════════════════════════════ */
function loHTML(){
return `<div class="service-interface" style="padding:0">
<style>
.lo-wrap{background:#030c1c;border-radius:14px;overflow:hidden;display:flex;flex-direction:column}
.lo-topbar{background:linear-gradient(135deg,#a00,#700);display:flex;align-items:center;gap:.5rem;padding:.6rem 1rem;border-bottom:2px solid #e00;flex-wrap:wrap}
.lo-topbar h3{color:#fff;font-size:.9rem;font-weight:800;margin-right:auto;display:flex;align-items:center;gap:6px}
.lo-tb-btn{display:flex;align-items:center;gap:5px;padding:5px 12px;border-radius:8px;font-size:.78rem;font-weight:700;cursor:pointer;border:none;font-family:inherit;transition:all .2s;white-space:nowrap}
/* Tabs */
.lo-tabs{display:flex;gap:0;border-bottom:1px solid rgba(255,255,255,.07);background:#08080f;flex-shrink:0}
.lo-tab{flex:1;padding:.55rem;background:transparent;border:none;border-bottom:2px solid transparent;color:#556677;font-size:.78rem;font-weight:700;cursor:pointer;font-family:inherit;transition:all .2s;display:flex;align-items:center;justify-content:center;gap:5px}
.lo-tab.active{color:#00e5ff;border-bottom-color:#00e5ff;background:rgba(0,229,255,.06)}
.lo-tab:hover{color:#ccc}
/* Tab contents */
.lo-tab-content{display:none;padding:1rem;overflow-y:auto;max-height:520px}
.lo-tab-content.active{display:block}
/* Auto source card */
.lo-source-card{background:rgba(255,255,255,.04);border:1.5px solid rgba(255,255,255,.09);border-radius:12px;padding:1rem;margin-bottom:.8rem;transition:all .25s}
.lo-source-card.selected{border-color:#00e5ff;background:rgba(0,229,255,.07)}
.lo-source-card-header{display:flex;align-items:center;gap:.6rem;cursor:pointer}
.lo-source-card-header h4{color:#fff;font-size:.88rem;font-weight:700;margin:0;flex:1}
.lo-source-icon{width:38px;height:38px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:1.2rem;flex-shrink:0}
.lo-source-badge{font-size:.68rem;font-weight:800;padding:2px 8px;border-radius:20px}
.lo-source-body{margin-top:.7rem;display:none}
.lo-source-card.selected .lo-source-body{display:block}
.lo-source-desc{color:#667788;font-size:.78rem;margin-bottom:.6rem;line-height:1.6}
/* Status bar */
.lo-status-bar{display:flex;align-items:center;gap:.5rem;padding:.45rem 1rem;background:rgba(0,0,0,.45);border-top:1px solid rgba(255,255,255,.05);font-size:.72rem;flex-wrap:wrap;flex-shrink:0}
.lo-status-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.lo-status-dot.live{background:#44ee55;animation:dotPulse 1.4s infinite}
.lo-status-dot.manual{background:#ffd700}
.lo-status-dot.error{background:#f44}
@keyframes dotPulse{0%,100%{box-shadow:0 0 0 0 rgba(68,238,85,.5)}50%{box-shadow:0 0 0 5px transparent}}
/* Form inputs */
.lo-inp{width:100%;background:rgba(0,0,0,.45);border:1px solid rgba(0,229,255,.2);border-radius:8px;color:#fff;padding:7px 10px;font-size:.82rem;font-family:inherit}
.lo-inp:focus{outline:none;border-color:#00e5ff}
.lo-label{color:#889aaa;font-size:.74rem;margin-bottom:.25rem;display:block}
.lo-fgroup{margin-bottom:.6rem}
/* Table */
.lo-table-wrap{overflow-x:auto;max-height:420px;overflow-y:auto}
.lo-table{width:100%;border-collapse:collapse;min-width:680px;font-size:.82rem}
.lo-table th{background:#0a1828;color:#4a6070;font-size:.68rem;font-weight:700;padding:6px 6px;text-align:center;text-transform:uppercase;letter-spacing:.4px;position:sticky;top:0;z-index:2;border-bottom:1px solid rgba(0,229,255,.18)}
.lo-table td{padding:5px 5px;border-bottom:1px solid rgba(255,255,255,.04);vertical-align:middle}
.lo-table tr:hover td{background:rgba(0,229,255,.04)}
.lo-rank{text-align:center;font-weight:800;color:#445566;font-size:.85rem}
.lo-name-inp{background:rgba(0,0,0,.4);border:1px solid rgba(0,229,255,.18);border-radius:6px;color:#fff;padding:4px 6px;font-size:.78rem;font-family:inherit;width:95px}
.lo-abbr-inp{background:rgba(0,0,0,.4);border:1px solid rgba(0,229,255,.15);border-radius:6px;color:#00e5ff;padding:3px 4px;font-size:.72rem;width:45px;text-align:center;font-family:inherit;font-weight:700;text-transform:uppercase}
.lo-players{display:flex;gap:3px;align-items:center;justify-content:center}
.lo-pbar{width:13px;height:28px;border-radius:3px;cursor:pointer;transition:all .2s;flex-shrink:0}
.lo-pbar.alive{background:linear-gradient(180deg,#44ee55,#22aa33);box-shadow:0 0 6px rgba(68,238,85,.4)}
.lo-pbar.knocked{background:linear-gradient(180deg,#ee5500,#aa2200);box-shadow:0 0 6px rgba(238,85,0,.4)}
.lo-pbar.eliminated{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.08)}
.lo-kills{display:flex;align-items:center;gap:2px}
.lo-kill-val{min-width:20px;text-align:center;font-weight:800;color:#ff8855;font-size:.88rem}
.lo-k-btn{width:20px;height:20px;border-radius:5px;border:none;cursor:pointer;font-size:.8rem;font-weight:900;font-family:inherit;display:flex;align-items:center;justify-content:center;transition:all .15s}
.lo-kp{background:rgba(68,238,85,.2);color:#44ee55}.lo-kp:hover{background:rgba(68,238,85,.4)}
.lo-km{background:rgba(255,85,0,.15);color:#ff5500}.lo-km:hover{background:rgba(255,85,0,.3)}
.lo-total{text-align:center;font-weight:900;font-size:.92rem}
.lo-del-btn{background:rgba(255,68,68,.1);border:1px solid rgba(255,68,68,.2);color:#f44;border-radius:6px;padding:2px 6px;cursor:pointer;font-family:inherit;font-size:.78rem}
.lo-del-btn:hover{background:rgba(255,68,68,.28)}
/* OCR */
.lo-ocr-dropzone{background:rgba(0,229,255,.04);border:2px dashed rgba(0,229,255,.25);border-radius:12px;padding:1.5rem;text-align:center;cursor:pointer;transition:all .25s}
.lo-ocr-dropzone:hover{border-color:#00e5ff;background:rgba(0,229,255,.09)}
.lo-ocr-dropzone i{font-size:2rem;color:#00e5ff;display:block;margin-bottom:.4rem}
.lo-ocr-preview{margin-top:.6rem;max-height:200px;overflow:hidden;border-radius:8px;border:1px solid rgba(0,229,255,.2)}
.lo-ocr-preview img{width:100%;display:block}
/* Auto-refresh badge */
.lo-auto-badge{display:inline-flex;align-items:center;gap:4px;background:rgba(68,238,85,.15);border:1px solid rgba(68,238,85,.3);color:#44ee55;padding:2px 8px;border-radius:20px;font-size:.68rem;font-weight:700}
/* Big btn */
.lo-big-btn{width:100%;padding:.8rem;border:none;border-radius:12px;font-weight:900;font-size:.9rem;cursor:pointer;font-family:inherit;transition:all .25s;display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:.5rem}
.lo-big-btn.primary{background:linear-gradient(135deg,#00e5ff,#0077ff);color:#000}
.lo-big-btn.primary:hover{background:linear-gradient(135deg,#0077ff,#00e5ff);color:#fff;transform:translateY(-1px);box-shadow:0 6px 18px rgba(0,229,255,.3)}
.lo-big-btn.danger{background:rgba(255,68,68,.15);border:1px solid rgba(255,68,68,.3);color:#f88}
.lo-big-btn.success{background:linear-gradient(135deg,#22cc44,#118822);color:#fff}
.lo-add-btn{width:100%;padding:.5rem;background:rgba(0,229,255,.07);border:1px dashed rgba(0,229,255,.28);border-radius:9px;color:#00e5ff;font-family:inherit;font-size:.8rem;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:5px;transition:all .2s;margin-top:.4rem}
.lo-add-btn:hover{background:rgba(0,229,255,.14)}
/* Dist popup */
.lo-dist-popup{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#0a1828;border:2px solid rgba(255,215,0,.45);border-radius:16px;padding:1.2rem;z-index:9999;box-shadow:0 20px 60px rgba(0,0,0,.9);width:300px;text-align:center}
.lo-dist-popup h4{color:#ffd700;font-size:.92rem;margin-bottom:.5rem}
.lo-dist-popup p{color:#8899aa;font-size:.78rem;line-height:1.6;margin-bottom:.8rem}
.lo-dist-list{background:rgba(0,0,0,.3);border-radius:9px;padding:.5rem;margin-bottom:.8rem;max-height:180px;overflow-y:auto;text-align:right}
.lo-di{display:flex;align-items:center;gap:.5rem;padding:.22rem .4rem;font-size:.78rem;border-bottom:1px solid rgba(255,255,255,.04)}
.lo-di:last-child{border-bottom:none}
.lo-di .r{color:#ffd700;font-weight:800;min-width:26px}.lo-di .n{color:#ccc;flex:1}.lo-di .p{color:#44ee55;font-weight:700}
.lo-dist-row{display:flex;gap:.5rem}
.lo-dist-ok{flex:2;padding:7px;background:linear-gradient(135deg,#ffd700,#ff9800);border:none;border-radius:9px;color:#000;font-weight:900;font-size:.85rem;cursor:pointer;font-family:inherit}
.lo-dist-cancel{flex:1;padding:7px;background:rgba(255,68,68,.12);border:1px solid rgba(255,68,68,.25);border-radius:9px;color:#f44;font-weight:700;font-size:.8rem;cursor:pointer;font-family:inherit}
/* Elim badge */
.lo-elim-b{display:inline-flex;align-items:center;justify-content:center;background:#cc0000;color:#fff;border-radius:50%;width:18px;height:18px;font-size:.62rem;font-weight:900}
.lo-alive-b{background:rgba(68,238,85,.15);color:#44ee55;border:1px solid rgba(68,238,85,.25);border-radius:50%;width:18px;height:18px;font-size:.7rem;display:inline-flex;align-items:center;justify-content:center}
/* Place badge */
.lo-place-b{display:inline-flex;align-items:center;gap:3px;background:rgba(255,215,0,.14);border:1px solid rgba(255,215,0,.3);color:#ffd700;padding:1px 7px;border-radius:8px;font-size:.67rem;font-weight:800;cursor:pointer;transition:all .18s;white-space:nowrap}
.lo-place-b:hover{background:rgba(255,215,0,.25)}
.lo-place-b.no-p{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.1);color:#445566}
/* Popup place */
.lo-place-popup{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#0a1828;border:2px solid rgba(255,215,0,.4);border-radius:14px;padding:1rem;z-index:9999;box-shadow:0 20px 60px rgba(0,0,0,.9);min-width:255px}
.lo-place-popup h4{color:#ffd700;font-size:.85rem;margin-bottom:.65rem;text-align:center}
.lo-pl-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:.32rem}
.lo-pl-opt{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:7px;color:#ccc;padding:5px 3px;text-align:center;font-size:.76rem;font-weight:700;cursor:pointer;font-family:inherit;transition:all .14s;line-height:1.3}
.lo-pl-opt:hover{background:rgba(255,215,0,.2);color:#ffd700;border-color:rgba(255,215,0,.4)}
.lo-pl-cancel{margin-top:.55rem;width:100%;background:rgba(255,68,68,.12);border:1px solid rgba(255,68,68,.22);color:#f44;border-radius:8px;padding:5px;cursor:pointer;font-family:inherit;font-size:.78rem;font-weight:700}
/* Player names edit btn */
.lo-players-edit{background:rgba(0,229,255,.1);border:1px solid rgba(0,229,255,.22);color:#00e5ff;border-radius:6px;width:22px;height:22px;font-size:.68rem;cursor:pointer;margin-top:3px;display:block;margin-right:auto;margin-left:auto;transition:all .18s}
.lo-players-edit:hover{background:rgba(0,229,255,.22)}
/* Locked kill button */
.lo-k-btn:disabled{opacity:.3;cursor:not-allowed}
.lo-k-btn.locked{animation:loLockPulse 1s infinite}
@keyframes loLockPulse{50%{opacity:.5}}
/* Column visibility grid */
.lo-cv-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:.4rem .8rem}
.lo-cv-item{display:flex;align-items:center;gap:6px;color:#aabbcc;font-size:.78rem;cursor:pointer}
.lo-cv-item input{accent-color:#00e5ff;cursor:pointer}
.lo-placement-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:.5rem}
.lo-placement-item{display:flex;flex-direction:column;align-items:center;gap:3px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:8px;padding:.4rem}
.lo-placement-item label{color:#8899aa;font-size:.65rem;font-weight:700}
.lo-placement-item input{width:100%;text-align:center;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.1);border-radius:6px;color:#ffd700;font-weight:700;font-size:.85rem;padding:.25rem 0}
/* Background upload zones */
.lo-bg-zone{background:rgba(255,255,255,.03);border:1.5px dashed rgba(0,229,255,.25);border-radius:10px;padding:.7rem;text-align:center;cursor:pointer;transition:all .2s;position:relative}
.lo-bg-zone:hover{border-color:#00e5ff;background:rgba(0,229,255,.06)}
.lo-bg-zone img,.lo-bg-zone video{max-height:70px;border-radius:6px;margin-top:.3rem}
.lo-bg-clear{position:absolute;top:4px;left:4px;background:rgba(255,68,68,.7);color:#fff;border:none;border-radius:50%;width:20px;height:20px;font-size:.7rem;cursor:pointer;display:none}
.lo-bg-zone.has-bg .lo-bg-clear{display:block}
/* Scan camera */
.lo-scan-video-wrap{position:relative;background:#000;border-radius:10px;overflow:hidden;margin-bottom:.6rem}
.lo-scan-video-wrap video{width:100%;display:block}
.lo-scan-rect{position:absolute;border:2px solid #00e5ff;background:rgba(0,229,255,.12);cursor:move}
.lo-scan-handle{position:absolute;width:12px;height:12px;background:#00e5ff;border-radius:50%;bottom:-6px;left:-6px;cursor:nwse-resize}
.lo-pending-kill{position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#0a1828;border:2px solid #ffd700;border-radius:14px;padding:1rem 1.2rem;z-index:99999;box-shadow:0 12px 40px rgba(0,0,0,.7);text-align:center;min-width:280px}
.lo-pending-kill h4{color:#ffd700;font-size:.85rem;margin-bottom:.6rem}
.lo-pending-kill .lo-pk-row{display:flex;gap:.5rem;justify-content:center}
.lo-pending-kill button{padding:6px 16px;border-radius:8px;border:none;font-weight:800;font-size:.8rem;cursor:pointer;font-family:inherit}
/* Elim banner free-drag position zone */
.lo-eb-dragzone{position:relative;width:100%;aspect-ratio:16/9;background:repeating-linear-gradient(0deg,rgba(255,255,255,.04) 0 1px,transparent 1px 33.33%),repeating-linear-gradient(90deg,rgba(255,255,255,.04) 0 1px,transparent 1px 33.33%),rgba(0,0,0,.35);border:1.5px solid rgba(0,229,255,.25);border-radius:10px;cursor:crosshair;touch-action:none;user-select:none}
.lo-eb-dragzone-label{position:absolute;top:6px;left:50%;transform:translateX(-50%);font-size:.62rem;color:#556677;letter-spacing:.08em;text-transform:uppercase;pointer-events:none}
.lo-eb-dragmarker{position:absolute;width:20px;height:20px;border-radius:50%;background:radial-gradient(circle,#00e5ff,#0088aa);box-shadow:0 0 14px rgba(0,229,255,.7),0 0 0 4px rgba(0,229,255,.15);transform:translate(-50%,-50%);pointer-events:none}
.lo-eb-presets{display:flex;gap:.35rem;margin-top:.5rem;flex-wrap:wrap}
.lo-eb-presets button{flex:1;min-width:34px;padding:6px 0;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:7px;color:#8899aa;cursor:pointer;font-size:.85rem;transition:all .15s}
.lo-eb-presets button:hover{background:rgba(0,229,255,.15);border-color:#00e5ff;color:#00e5ff}
.lo-eb-slider{width:100%;accent-color:#00e5ff;cursor:pointer}
.lo-eb-team-btn{width:26px;height:26px;border-radius:6px;border:1px dashed rgba(255,255,255,.15);background:rgba(255,255,255,.04);cursor:pointer;font-size:.75rem;display:flex;align-items:center;justify-content:center;opacity:.55;transition:all .15s}
.lo-eb-team-btn:hover{opacity:1;border-color:rgba(0,229,255,.4)}
.lo-eb-team-btn.has{opacity:1;border:1px solid #00e5ff;background:rgba(0,229,255,.12);box-shadow:0 0 8px rgba(0,229,255,.3)}
.lo-scan-mode-btn{flex:1;padding:.6rem .5rem;background:rgba(255,255,255,.04);border:1.5px solid rgba(255,255,255,.1);border-radius:9px;color:#8899aa;cursor:pointer;font-size:.78rem;font-weight:700;font-family:inherit;transition:all .18s}
.lo-scan-mode-btn:hover{border-color:rgba(0,229,255,.35);color:#ccc}
.lo-scan-mode-btn.active{background:rgba(0,229,255,.15);border-color:#00e5ff;color:#00e5ff;box-shadow:0 0 12px rgba(0,229,255,.15)}
.lo-kill-picker-list{display:flex;flex-direction:column;gap:.4rem;max-height:280px;overflow-y:auto;margin-bottom:.7rem}
.lo-kill-picker-item{display:flex;align-items:center;gap:.6rem;background:rgba(255,255,255,.04);border:1.5px solid rgba(255,255,255,.12);border-radius:9px;padding:.55rem .7rem;cursor:pointer;font-family:inherit;transition:all .15s;text-align:right}
.lo-kill-picker-item:hover:not(:disabled){background:rgba(255,255,255,.09);transform:translateX(-2px)}
.lo-kill-picker-item:disabled{opacity:.35;cursor:not-allowed}
.lo-kpi-dot{width:11px;height:11px;border-radius:50%;flex-shrink:0}
.lo-kpi-name{color:#fff;font-weight:800;font-size:.84rem;flex:1}
.lo-kpi-count{color:#8899aa;font-size:.7rem;font-weight:700}
.lo-kills-v2{display:flex;flex-direction:column;align-items:center;gap:4px}
.lo-kills-v2 .lo-kill-val{color:#ffd700;font-weight:900;font-size:.95rem;cursor:pointer;border-bottom:1px dashed rgba(255,215,0,.4)}
.lo-kill-actions{display:flex;gap:4px}
.lo-ka-btn{border:none;border-radius:6px;padding:4px 7px;font-size:.66rem;font-weight:800;cursor:pointer;font-family:inherit;white-space:nowrap;transition:transform .12s}
.lo-ka-btn:hover{transform:translateY(-1px)}
.lo-ka-btn.kill{background:linear-gradient(135deg,#ff4444,#aa0000);color:#fff}
.lo-ka-btn.knock{background:linear-gradient(135deg,#ffaa00,#cc7700);color:#000}
.lo-kill-count-row{display:flex;gap:.5rem;justify-content:center}
.lo-kill-count-btn{width:44px;height:44px;border-radius:10px;border:1.5px solid rgba(0,229,255,.3);background:rgba(0,229,255,.08);color:#00e5ff;font-size:1.1rem;font-weight:900;cursor:pointer;font-family:inherit;transition:all .15s}
.lo-kill-count-btn:hover:not(:disabled){background:rgba(0,229,255,.2);transform:scale(1.06)}
.lo-kill-count-btn:disabled{opacity:.3;cursor:not-allowed}
.lo-flag-sel{background:rgba(0,0,0,.4);border:1px solid rgba(0,229,255,.2);border-radius:6px;color:#fff;font-size:1rem;padding:3px 4px;cursor:pointer;font-family:inherit;width:52px;text-align:center}
.lo-flag-sel:focus{outline:none;border-color:#00e5ff}
</style>

<div class="lo-wrap">
  <!-- Top bar -->
  <div class="lo-topbar">
    <h3>🔴 أوفرلي البث المباشر</h3>
    <div class="lo-auto-badge" id="loModeBadge">⚙️ يدوي</div>
    <button class="lo-tb-btn" style="background:#00ccff;color:#000" onclick="loOpenOverlay()"><i class="fas fa-external-link-alt"></i> OBS</button>
    <button class="lo-tb-btn" style="background:#ffd700;color:#000" onclick="loOpenSpotlightWindow()" title="نافذة منفصلة شفافة — تطلع فيها بس الفرق المتبقية"><i class="fas fa-th"></i> نافذة الفرق المتبقية</button>
    <button class="lo-tb-btn" style="background:#ff4466;color:#fff" onclick="loOpenKillCardWindow()" title="نافذة منفصلة شفافة — تطلع فيها بس كارد كل قتلة"><i class="fas fa-skull"></i> نافذة كارد القتلة</button>
    <button class="lo-tb-btn" style="background:linear-gradient(135deg,#ffd700,#ff9800);color:#000;font-weight:900" onclick="loShowDist()">🏁 توزيع المراكز</button>
    <button class="lo-tb-btn" style="background:rgba(0,229,255,.15);color:#00e5ff;border:1px solid rgba(0,229,255,.3)" onclick="loNewRound()">↺ جولة جديدة</button>
    <button class="lo-tb-btn" style="background:rgba(255,80,0,.15);color:#ff8844;border:1px solid rgba(255,80,0,.25)" onclick="loReset()">🗑</button>
  </div>

  <!-- Tabs -->
  <div class="lo-tabs">
    <button class="lo-tab active" data-tab="loAutoTab" onclick="loSwitchTab('loAutoTab',this)"><i class="fas fa-magic"></i> الربط التلقائي</button>
    <button class="lo-tab" data-tab="loTeamsTab" onclick="loSwitchTab('loTeamsTab',this)"><i class="fas fa-users"></i> الفرق</button>
    <button class="lo-tab" data-tab="loScanTab" onclick="loSwitchTab('loScanTab',this)"><i class="fas fa-video"></i> كاميرا المسح</button>
    <button class="lo-tab" data-tab="loSettingsTab" onclick="loSwitchTab('loSettingsTab',this)"><i class="fas fa-cog"></i> الإعدادات</button>
  </div>

  <!-- ── AUTO TAB ── -->
  <div id="loAutoTab" class="lo-tab-content active">

    <!-- OCR Source -->
    <div class="lo-source-card selected" id="srcOCR" onclick="loSelectSource('ocr','srcOCR')">
      <div class="lo-source-card-header">
        <div class="lo-source-icon" style="background:rgba(0,229,255,.15)">📷</div>
        <h4>OCR — لقطة شاشة الروم</h4>
        <span class="lo-source-badge" style="background:rgba(68,238,85,.15);color:#44ee55;border:1px solid rgba(68,238,85,.3)">الأسهل</span>
      </div>
      <div class="lo-source-body">
        <p class="lo-source-desc">
          📌 <b>خطوات الربط:</b><br>
          1. خلال الكيم افتح قائمة النتائج (tab أو زر الترتيب)<br>
          2. خذ screenshot وارفعه هنا<br>
          3. النظام يقرأ الأسماء والقتلات والنقاط تلقائياً
        </p>
        <div class="lo-ocr-dropzone" onclick="document.getElementById('loOcrFile').click()">
          <i class="fas fa-camera"></i>
          <span style="color:#667788;font-size:.82rem" id="loOcrLbl">ارفع screenshot الروم هنا</span>
          <input type="file" id="loOcrFile" accept="image/*" style="display:none" onchange="loOCRProcess(this)">
        </div>
        <div id="loOcrPreview" style="display:none" class="lo-ocr-preview"></div>
        <div id="loOcrResult" style="display:none;margin-top:.6rem"></div>
        <button class="lo-big-btn primary" style="margin-top:.6rem" onclick="document.getElementById('loOcrFile').click()">
          <i class="fas fa-camera"></i> تحديث بلقطة جديدة
        </button>
        <div style="background:rgba(255,215,0,.06);border:1px solid rgba(255,215,0,.2);border-radius:8px;padding:.5rem .7rem;margin-top:.4rem;color:#aaa;font-size:.72rem">
          💡 يشتغل على PUBG Mobile وكل ألعاب الإيسبورت — يدعم العربي والإنجليزي
        </div>
      </div>
    </div>

    <!-- PUBG API Source -->
    <div class="lo-source-card" id="srcAPI" onclick="loSelectSource('api','srcAPI')">
      <div class="lo-source-card-header">
        <div class="lo-source-icon" style="background:rgba(255,215,0,.15)">🔗</div>
        <h4>PUBG API — تحديث تلقائي بعد كل كيم</h4>
        <span class="lo-source-badge" style="background:rgba(0,229,255,.12);color:#00e5ff;border:1px solid rgba(0,229,255,.25)">API</span>
      </div>
      <div class="lo-source-body">
        <p class="lo-source-desc">
          يراقب مباريات اللاعب عبر PUBG API الرسمي ويجلب النتائج تلقائياً بعد انتهاء كل كيم.
          يحتاج API Key مجاني من <a href="https://developer.pubg.com/" target="_blank" style="color:#00e5ff">developer.pubg.com</a>
        </p>
        <div class="lo-fgroup">
          <label class="lo-label">PUBG API Key</label>
          <input class="lo-inp" id="loApiKey" placeholder="eyJhbGci..." oninput="loApiKey=this.value">
        </div>
        <div class="lo-fgroup">
          <label class="lo-label">اسم اللاعب / الفريق (للمراقبة)</label>
          <input class="lo-inp" id="loPlayerName" placeholder="Eyad_Eyad12" oninput="loPlayerName=this.value">
        </div>
        <div class="lo-fgroup">
          <label class="lo-label">السيرفر</label>
          <select class="lo-inp" id="loShard">
            <option value="kakao">PUBG Mobile (kakao)</option>
            <option value="console-KAKAO">Console</option>
            <option value="steam">PC Steam</option>
          </select>
        </div>
        <button class="lo-big-btn primary" onclick="loAPIConnect()">
          <i class="fas fa-link"></i> ربط وبدء المراقبة
        </button>
        <div id="loAPIStatus"></div>
        <div style="background:rgba(0,229,255,.05);border:1px solid rgba(0,229,255,.15);border-radius:8px;padding:.5rem .7rem;margin-top:.4rem;color:#667788;font-size:.72rem">
          ⏱️ يتحدث تلقائياً بعد انتهاء كل مباراة (تأخير ~2 دقيقة)
        </div>
      </div>
    </div>

    <!-- Manual Source -->
    <div class="lo-source-card" id="srcManual" onclick="loSelectSource('manual','srcManual')">
      <div class="lo-source-card-header">
        <div class="lo-source-icon" style="background:rgba(255,107,53,.15)">🎮</div>
        <h4>يدوي — تحكم مباشر</h4>
        <span class="lo-source-badge" style="background:rgba(255,107,53,.15);color:#ff8855;border:1px solid rgba(255,107,53,.3)">يدوي</span>
      </div>
    </div>
  </div>

  <!-- ── SCAN CAMERA TAB ── -->
  <div id="loScanTab" class="lo-tab-content">
    <div style="background:rgba(255,215,0,.06);border:1px solid rgba(255,215,0,.2);border-radius:9px;padding:.6rem .8rem;margin-bottom:.7rem;color:#ddd;font-size:.76rem;line-height:1.7">
      💡 اختر منطقة "كيل فيد" (Kill Feed) بالبث، والنظام يراقبها ويحدّث الجدول وحده أول بأول — يكتشف أكثر من حدث بنفس المسحة (نوك/تفنيش لعدة فرق سوا).
    </div>

    <div class="lo-fgroup" style="margin-bottom:.9rem">
      <label class="lo-label">مصدر المسح</label>
      <div style="display:flex;gap:.5rem">
        <button class="lo-scan-mode-btn active" data-mode="killfeed" onclick="loSetScanMode('killfeed')">📰 كيل فيد</button>
        <button class="lo-scan-mode-btn" data-mode="board" onclick="loSetScanMode('board')">📋 لوحة كل الفرق</button>
        <button class="lo-scan-mode-btn" data-mode="spectate" onclick="loSetScanMode('spectate')">📊 كارد المشاهدة</button>
      </div>
      <div style="color:#8899aa;font-size:.7rem;margin-top:.5rem;line-height:1.6" id="loScanModeHint">
        يراقب سطر "فلان قتل فلان" بالكيل فيد ويحدّث حالة اللاعب المحدد فقط (نوك/تفنيش) لحظة حدوثه.
      </div>
    </div>

    <div style="background:rgba(0,229,255,.05);border:1px solid rgba(0,229,255,.18);border-radius:10px;padding:.7rem .8rem;margin-bottom:.9rem">
      <label style="display:flex;align-items:center;gap:.5rem;cursor:pointer;margin-bottom:.6rem">
        <input type="checkbox" id="loOcrAutoChk" checked onchange="loSetOcrAutoApply(this.checked)" style="width:16px;height:16px;accent-color:#00e5ff">
        <span style="color:#00e5ff;font-weight:800;font-size:.82rem">⚡ تطبيق تلقائي فوري (بدون تأكيد يدوي)</span>
      </label>
      <div style="color:#8899aa;font-size:.7rem;line-height:1.6;margin-bottom:.6rem">
        مفعّل: أي حدث يتأكد وجوده يتطبّق لحظياً على الجدول (نوك/تفنيش)، وتقدر تسوي "↩️ تراجع" من الإشعار خلال ٦ ثواني لو صار خطأ.
        <br>مو مفعّل: تطلع نافذة تأكيد صغيرة لكل حدث، وتصف بالطابور إذا صارت أكثر من حالة بنفس الوقت.
      </div>
      <div style="display:flex;align-items:center;gap:.6rem">
        <label class="lo-label" style="margin:0">فترة المسح:</label>
        <select class="lo-inp" id="loScanIntervalSel" style="width:auto;flex:1" onchange="loSetScanInterval(this.value)">
          <option value="2000">سريع (ثانيتين) — تكلفة API أعلى</option>
          <option value="3000" selected>عادي (٣ ثواني)</option>
          <option value="5000">اقتصادي (٥ ثواني)</option>
        </select>
      </div>
    </div>

    <div id="loScanSetup">
      <button class="lo-big-btn primary" onclick="loStartScanSetup()">
        <i class="fas fa-desktop"></i> اختيار الشاشة/النافذة ومنطقة المسح
      </button>
    </div>

    <div id="loScanPicker" style="display:none">
      <div class="lo-scan-video-wrap" id="loScanVideoWrap">
        <video id="loScanVideo" autoplay muted playsinline></video>
        <div class="lo-scan-rect" id="loScanRect" style="left:20%;top:20%;width:200px;height:80px">
          <div class="lo-scan-handle" id="loScanHandle"></div>
        </div>
      </div>
      <p style="color:#889aaa;font-size:.75rem;text-align:center;margin-bottom:.5rem" id="loScanPickerHint">اسحب المربع وحجّمه فوق منطقة أسماء اللاعبين بالكيل فيد</p>
      <button class="lo-big-btn success" onclick="loConfirmScanRegion()"><i class="fas fa-check"></i> تأكيد المنطقة وبدء المراقبة</button>
      <button class="lo-big-btn danger" onclick="loCancelScanSetup()">إلغاء</button>
    </div>

    <div id="loScanActive" style="display:none">
      <div style="display:flex;align-items:center;gap:.6rem;background:rgba(68,238,85,.08);border:1px solid rgba(68,238,85,.25);border-radius:10px;padding:.6rem .8rem;margin-bottom:.7rem">
        <div class="lo-status-dot live"></div>
        <span style="color:#44ee55;font-size:.82rem;font-weight:700" id="loScanStatusTxt">المراقبة تعمل — كل 3 ثواني</span>
      </div>
      <div id="loScanThumbWrap" style="border-radius:9px;overflow:hidden;border:1px solid rgba(0,229,255,.2);margin-bottom:.6rem"></div>
      <button class="lo-big-btn" style="background:rgba(255,215,0,.12);color:#ffd700;border:1px solid rgba(255,215,0,.3);margin-bottom:.6rem;display:none" id="loUndoBoardBtn" onclick="loUndoBoardSync()">↩️ تراجع آخر مزامنة</button>
      <div id="loScanLog" style="max-height:160px;overflow-y:auto;background:rgba(0,0,0,.3);border-radius:9px;padding:.5rem;font-size:.74rem;color:#889aaa;margin-bottom:.6rem"></div>
      <button class="lo-big-btn danger" onclick="loStopScan()"><i class="fas fa-stop"></i> إيقاف المراقبة</button>
    </div>
  </div>

  <!-- ── TEAMS TAB ── -->
  <div id="loTeamsTab" class="lo-tab-content">
    <div class="lo-table-wrap">
      <table class="lo-table" id="loTable">
        <thead><tr>
          <th data-col="rank">#</th><th data-col="elim">تسلسل موت</th>
          <th data-col="logo">شعار</th><th data-col="flag">علم</th><th data-col="color">لون</th>
          <th data-col="name">اسم الفريق</th>
          <th data-col="abbr">اختصار</th><th data-col="players">اللاعبون</th>
          <th data-col="kills">قتلات</th><th data-col="place">مكان</th><th data-col="total">مجموع</th><th></th>
        </tr></thead>
        <tbody id="loTbody"></tbody>
      </table>
    </div>
    <button class="lo-add-btn" onclick="loAddTeam()"><i class="fas fa-plus"></i> إضافة فريق</button>
  </div>

  <!-- ── SETTINGS TAB ── -->
  <div id="loSettingsTab" class="lo-tab-content">
    <div style="display:flex;flex-direction:column;gap:.8rem">
      <div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:11px;padding:.9rem">
        <div style="color:#00e5ff;font-size:.75rem;font-weight:800;margin-bottom:.7rem">🎨 إعدادات الأوفرلي</div>
        <div class="lo-fgroup">
          <label class="lo-label">عنوان البطولة</label>
          <input class="lo-inp" id="loTournTitle" placeholder="PUBG Mobile Championship" oninput="loBroadcast()">
        </div>
        <div class="lo-fgroup">
          <label class="lo-label">عدد الفرق المعروضة في الأوفرلي</label>
          <input class="lo-inp" type="number" id="loShowCount" value="16" min="4" max="20" oninput="loBroadcast()">
        </div>
        <div style="display:flex;gap:.5rem">
          <div style="flex:1">
            <label class="lo-label">لون الأوفرلي</label>
            <select class="lo-inp" id="loOverlayTheme" onchange="loBroadcast()">
              <option value="pubg">PUBG أصلي</option>
              <option value="dark">داكن</option>
              <option value="neon">نيون</option>
              <option value="red">أحمر</option>
            </select>
          </div>
          <div style="flex:1">
            <label class="lo-label">حجم الخط</label>
            <select class="lo-inp" id="loFontSize" onchange="loBroadcast()">
              <option value="sm">صغير</option>
              <option value="md" selected>متوسط</option>
              <option value="lg">كبير</option>
            </select>
          </div>
        </div>
      </div>
      <button class="lo-big-btn primary" onclick="loOpenOverlay()"><i class="fas fa-external-link-alt"></i> فتح الأوفرلي للـ OBS</button>
      <button class="lo-big-btn" style="background:rgba(255,255,255,.07);color:#aaa;border:1px solid rgba(255,255,255,.12)" onclick="loExportJSON()"><i class="fas fa-download"></i> تصدير بيانات الجولة JSON</button>

      <!-- إظهار/إخفاء الأعمدة -->
      <div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:11px;padding:.9rem">
        <div style="color:#00e5ff;font-size:.75rem;font-weight:800;margin-bottom:.7rem">👁️ الأعمدة الظاهرة بالأوفرلي</div>
        <div class="lo-cv-grid">
          <label class="lo-cv-item"><input type="checkbox" id="loCv_rank" checked onchange="loToggleCol('rank',this.checked)"> الترتيب #</label>
          <label class="lo-cv-item"><input type="checkbox" id="loCv_elim" checked onchange="loToggleCol('elim',this.checked)"> تسلسل الموت</label>
          <label class="lo-cv-item"><input type="checkbox" id="loCv_logo" checked onchange="loToggleCol('logo',this.checked)"> شعار الفريق</label>
          <label class="lo-cv-item"><input type="checkbox" id="loCv_flag" checked onchange="loToggleCol('flag',this.checked)"> علم الفريق</label>
          <label class="lo-cv-item"><input type="checkbox" id="loCv_color" checked onchange="loToggleCol('color',this.checked)"> لون الفريق</label>
          <label class="lo-cv-item"><input type="checkbox" id="loCv_name" checked onchange="loToggleCol('name',this.checked)"> اسم الفريق</label>
          <label class="lo-cv-item"><input type="checkbox" id="loCv_abbr" checked onchange="loToggleCol('abbr',this.checked)"> الاختصار</label>
          <label class="lo-cv-item"><input type="checkbox" id="loCv_players" checked onchange="loToggleCol('players',this.checked)"> اللاعبون</label>
          <label class="lo-cv-item"><input type="checkbox" id="loCv_kills" checked onchange="loToggleCol('kills',this.checked)"> القتلات</label>
          <label class="lo-cv-item"><input type="checkbox" id="loCv_place" checked onchange="loToggleCol('place',this.checked)"> المكان</label>
          <label class="lo-cv-item"><input type="checkbox" id="loCv_total" checked onchange="loToggleCol('total',this.checked)"> المجموع</label>
        </div>
      </div>

      <!-- نقاط المراكز -->
      <div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:11px;padding:.9rem">
        <div style="color:#00e5ff;font-size:.75rem;font-weight:800;margin-bottom:.7rem">🏆 نقاط المراكز</div>
        <div style="color:#556677;font-size:.68rem;margin-bottom:.6rem">حدد كم نقطة ياخذ كل مركز عند التصفية — يتحدث تلقائياً على أي فريق مصنّف حالياً</div>
        <div id="loPlacementGrid" class="lo-placement-grid"></div>
      </div>

      <!-- الخلفيات -->
      <div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:11px;padding:.9rem">
        <div style="color:#00e5ff;font-size:.75rem;font-weight:800;margin-bottom:.7rem">🖼️ خلفية الأوفرلي (صورة أو فيديو)</div>
        <div class="lo-fgroup">
          <label class="lo-label">🔴 خلفية الشريط الأول (العنوان العلوي)</label>
          <div class="lo-bg-zone" id="loHeaderBgZone" onclick="document.getElementById('loHeaderBgInp').click()">
            <button class="lo-bg-clear" onclick="event.stopPropagation();loClearBg('headerBg')">✕</button>
            <i class="fas fa-image" style="color:#00e5ff;font-size:1.3rem"></i>
            <div id="loHeaderBgPreview"></div>
            <div style="color:#667788;font-size:.72rem;margin-top:.2rem">اضغط لرفع صورة/فيديو</div>
          </div>
          <input type="file" id="loHeaderBgInp" accept="image/*,video/*" style="display:none" onchange="loSetBg('headerBg',this)">
        </div>
        <div class="lo-fgroup">
          <label class="lo-label">⬛ خلفية الشريط الثاني (جدول الفرق)</label>
          <div class="lo-bg-zone" id="loBodyBgZone" onclick="document.getElementById('loBodyBgInp').click()">
            <button class="lo-bg-clear" onclick="event.stopPropagation();loClearBg('bodyBg')">✕</button>
            <i class="fas fa-image" style="color:#00e5ff;font-size:1.3rem"></i>
            <div id="loBodyBgPreview"></div>
            <div style="color:#667788;font-size:.72rem;margin-top:.2rem">اضغط لرفع صورة/فيديو</div>
          </div>
          <input type="file" id="loBodyBgInp" accept="image/*,video/*" style="display:none" onchange="loSetBg('bodyBg',this)">
        </div>
      </div>

      <!-- إشعار الإقصاء -->
      <div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:11px;padding:.9rem">
        <div style="color:#00e5ff;font-size:.75rem;font-weight:800;margin-bottom:.7rem">🔔 إشعار موت الفريق (البانر)</div>

        <div class="lo-fgroup">
          <label class="lo-label">مكان ظهوره — اسحب النقطة لأي مكان تريده</label>
          <div class="lo-eb-dragzone" id="loEbDragZone" onmousedown="loEbDragStart(event)" ontouchstart="loEbDragStart(event)">
            <div class="lo-eb-dragzone-label">شاشة الأوفرلي</div>
            <div class="lo-eb-dragmarker" id="loEbDragMarker" style="left:50%;top:50%"></div>
          </div>
          <div class="lo-eb-presets">
            <button onclick="loSetEbPreset(14,14)" title="أعلى يسار">↖</button>
            <button onclick="loSetEbPreset(50,14)" title="أعلى وسط">↑</button>
            <button onclick="loSetEbPreset(86,14)" title="أعلى يمين">↗</button>
            <button onclick="loSetEbPreset(50,50)" title="الوسط">●</button>
            <button onclick="loSetEbPreset(14,86)" title="أسفل يسار">↙</button>
            <button onclick="loSetEbPreset(50,86)" title="أسفل وسط">↓</button>
            <button onclick="loSetEbPreset(86,86)" title="أسفل يمين">↘</button>
          </div>
        </div>

        <div class="lo-fgroup">
          <label class="lo-label">الحجم: <span id="loEbScaleVal" style="color:#00e5ff">100%</span></label>
          <input type="range" class="lo-eb-slider" id="loEbScale" min="60" max="160" value="100" oninput="loSetEbScale(this.value)">
        </div>

        <div class="lo-fgroup">
          <label class="lo-label">🖼️ خلفية عامة للبانر (صورة أو فيديو) — اختياري</label>
          <div class="lo-bg-zone" id="loEbBgZone" onclick="document.getElementById('loEbBgInp').click()">
            <button class="lo-bg-clear" onclick="event.stopPropagation();loClearBg('elimBannerBg')">✕</button>
            <i class="fas fa-image" style="color:#00e5ff;font-size:1.3rem"></i>
            <div id="loEbBgPreview"></div>
            <div style="color:#667788;font-size:.72rem;margin-top:.2rem">اضغط لرفع صورة/فيديو</div>
          </div>
          <input type="file" id="loEbBgInp" accept="image/*,video/*" style="display:none" onchange="loSetBg('elimBannerBg',this)">
          <div style="color:#556677;font-size:.68rem;margin-top:.4rem">💡 تگدر تسوي خلفية خاصة لكل فريق لحاله من أيقونة 🎬 بجدول الفرق</div>
        </div>

        <button class="lo-big-btn primary" onclick="loTestElimBanner()"><i class="fas fa-bell"></i> تجربة الإشعار الآن</button>
        <button class="lo-big-btn" style="background:linear-gradient(135deg,#ff4d4d,#b30000);margin-top:.5rem" onclick="loOpenDisqualifyPicker()"><i class="fas fa-gavel"></i> إقصاء فريق لمخالفة القوانين</button>
      </div>

      <!-- عرض الفرق المتبقية الدوّار -->
      <div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:11px;padding:.9rem">
        <div style="color:#00e5ff;font-size:.75rem;font-weight:800;margin-bottom:.7rem;display:flex;align-items:center;justify-content:space-between">
          <span>🎯 عرض الفرق المتبقية الدوّار</span>
          <label style="display:flex;align-items:center;gap:.3rem;font-size:.7rem;color:#8899aa;font-weight:400;cursor:pointer">
            <input type="checkbox" id="loSpotEnabled" checked onchange="loSetSpotlightEnabled(this.checked)"> تفعيل
          </label>
        </div>
        <div style="color:#8899aa;font-size:.72rem;margin-bottom:.7rem;line-height:1.6">
          عند وصول عدد الفرق الحية للحد المحدد، تطلع كل الفرق الباقية معاً بشريط واحد (مربع لكل فريق: مركزه، اسمه، نسبة فوزه من نقاطه، ونسبة قتلاته — والنسب تكمّل 100%)، لعدد مرات محدد، ثم يختفي.
          <br>⚠️ هذا العرض يطلع بـ<b style="color:#ffd700">نافذة منفصلة شفافة بالكامل</b> — لازم تسحبها كمصدر Browser Source ثاني بـ OBS (زر "نافذة الفرق المتبقية" فوق)، منفصلة عن نافذة جدول الفرق.
        </div>
        <button class="lo-big-btn primary" style="background:#ffd700;color:#000;margin-bottom:.7rem" onclick="loOpenSpotlightWindow()"><i class="fas fa-th"></i> فتح نافذة الفرق المتبقية</button>
        <div style="display:flex;gap:.7rem">
          <div class="lo-fgroup" style="flex:1">
            <label class="lo-label">يبدأ عند بقاء</label>
            <input type="number" class="lo-inp" id="loSpotTrigger" min="1" max="20" value="5" oninput="loSetSpotlightN('triggerCount',this.value)">
          </div>
          <div class="lo-fgroup" style="flex:1">
            <label class="lo-label">عدد الدورات</label>
            <input type="number" class="lo-inp" id="loSpotCycles" min="1" max="10" value="3" oninput="loSetSpotlightN('cycles',this.value)">
          </div>
        </div>
      </div>

      <!-- كارد القتلة المفردة -->
      <div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:11px;padding:.9rem">
        <div style="color:#00e5ff;font-size:.75rem;font-weight:800;margin-bottom:.7rem">💀 كارد القتلة المفردة</div>
        <div style="color:#8899aa;font-size:.72rem;margin-bottom:.7rem;line-height:1.6">
          يطلع لكل قتلة (شعار الفريق + اسمه + الضرر + المسافة + الإسقاطات) — يدوياً من أزرار "☠️ قتل" بجدول الفرق،
          أو تلقائياً من وضع مسح "📊 كارد المشاهدة" بتاب كاميرا المسح.
          <br>⚠️ يطلع بـ<b style="color:#ffd700">نافذة منفصلة شفافة بالكامل</b> — اسحبها كمصدر Browser Source ثالث بـ OBS (زر "نافذة كارد القتلة" فوق).
        </div>
        <button class="lo-big-btn primary" style="background:#ff4466;color:#fff;margin-bottom:.7rem" onclick="loOpenKillCardWindow()"><i class="fas fa-skull"></i> فتح نافذة كارد القتلة</button>
        <div class="lo-fgroup">
          <label class="lo-label">🖼️ خلفية الكارد (صورة أو فيديو) — اختياري</label>
          <div class="lo-bg-zone" id="loKcBgZone" onclick="document.getElementById('loKcBgInp').click()">
            <button class="lo-bg-clear" onclick="event.stopPropagation();loClearBg('killCardBg')">✕</button>
            <i class="fas fa-image" style="color:#00e5ff;font-size:1.3rem"></i>
            <div id="loKcBgPreview"></div>
            <div style="color:#667788;font-size:.72rem;margin-top:.2rem">اضغط لرفع صورة/فيديو (مثلاً شعار الأورگ)</div>
          </div>
          <input type="file" id="loKcBgInp" accept="image/*,video/*" style="display:none" onchange="loSetBg('killCardBg',this)">
        </div>
      </div>
    </div>
  </div>

  <!-- Status bar -->
  <div class="lo-status-bar">
    <div class="lo-status-dot manual" id="loStatusDot"></div>
    <span id="loStatusTxt" style="color:#556677">وضع يدوي</span>
    <span style="margin-right:auto"></span>
    <span style="color:#445566">فرق: <b id="loTC" style="color:#00e5ff">0</b></span>
    <span style="color:#445566">منتهيين: <b id="loEC" style="color:#ff6644">0</b></span>
    <span style="color:#445566">تحديث: <b id="loUT" style="color:#00e5ff">--</b></span>
  </div>
</div>`;
}

/* ════ Init ════ */
function loInit(){
    const saved=loLoad();
    if(saved?.teams?.length){
        loTeams=saved.teams.map(loMigratePlayers).map(t=>({...t,flag:loMigrateFlag(t.flag)}));
        loEliminationOrder=saved.elimOrder||[];
        loNextId=Math.max(...loTeams.map(t=>t.id),0)+1;
    } else {
        loTeams=loDefaultTeams();
    }
    /* Load API key from localStorage */
    const cfg=JSON.parse(localStorage.getItem('lo_config')||'{}');
    if(cfg.apiKey){ loApiKey=cfg.apiKey; const el=document.getElementById('loApiKey'); if(el) el.value=cfg.apiKey; }
    if(cfg.playerName){ loPlayerName=cfg.playerName; const el=document.getElementById('loPlayerName'); if(el) el.value=cfg.playerName; }

    /* Load column visibility */
    try{ const cv=JSON.parse(localStorage.getItem('lo_colvis')||'null'); if(cv) loColVis={...loColVis,...cv}; }catch(_){}
    /* إعدادات بانر الإقصاء (مكان/حجم — بيانات صغيرة، localStorage مناسب لها) */
    try{ const eb=JSON.parse(localStorage.getItem('lo_elim_banner_cfg')||'null'); if(eb) loElimBannerCfg={...loElimBannerCfg,...eb}; }catch(_){}
    try{ const sp=JSON.parse(localStorage.getItem('lo_spotlight_cfg')||'null'); if(sp) loSpotlightCfg={...loSpotlightCfg,...sp}; }catch(_){}
    try{ const av=JSON.parse(localStorage.getItem('lo_ocr_auto_apply')||'null'); if(av!==null) loOcrAutoApply=av; }catch(_){}
    try{ const si=parseInt(localStorage.getItem('lo_scan_interval')); if(si) loScanIntervalMs=si; }catch(_){}
    try{ const pp=JSON.parse(localStorage.getItem('lo_placement_points')||'null'); if(Array.isArray(pp)) LO_PLACEMENT=pp; }catch(_){}
    loSyncColVisUI();
    loSyncEbUI();
    loSyncSpotlightUI();
    loSyncBgUI();
    loSyncPlacementUI();
    const ocrChk=document.getElementById('loOcrAutoChk'); if(ocrChk) ocrChk.checked=loOcrAutoApply;
    const siSel=document.getElementById('loScanIntervalSel'); if(siSel) siSel.value=String(loScanIntervalMs);

    try{ loBc=new BroadcastChannel(LO_CH); }catch(_){}
    loRenderTable();
    loBroadcast();

    /* الخلفيات (صور/فيديو) تُحمّل من IndexedDB بشكل غير متزامن لأنها قد تكون كبيرة الحجم؛
       بعد تحميلها نعيد البث حتى تصل لأي نافذة أوفرلي مفتوحة */
    (async()=>{
        try{
            const keys=['headerBg','bodyBg','elimBannerBg','killCardBg'];
            for(const k of keys){
                const v=await loIdbGet(k);
                if(v) loBgSettings[k]=v;
            }
            /* خلفيات الإقصاء الخاصة بكل فريق */
            for(const t of loTeams){
                const v=await loIdbGet('elimBg_team_'+t.id);
                if(v) loTeamElimBg[t.id]=v;
            }
            loSyncBgUI();
            loRenderTable();
            loBroadcast();
        }catch(e){ console.warn('[loInit] تعذر تحميل الخلفيات من IndexedDB:',e); }
    })();
}

function loLoad(){ try{ return JSON.parse(localStorage.getItem(LO_KEY)||'null'); }catch(_){ return null; } }
function loSave(){
    /* بيانات الفرق نفسها خفيفة (نصوص/أرقام) — لا تحتوي فيديو، فهذا الحفظ آمن دائماً تقريباً،
       لكن نحوّطها بمحاولة/التقاط بأي حال حتى لا تكسر بقية loBroadcast() لو صار شيء غير متوقع */
    try{
        localStorage.setItem(LO_KEY,JSON.stringify({teams:loTeams,elimOrder:loEliminationOrder,updated:Date.now()}));
    }catch(e){ console.warn('[loSave] فشل حفظ بيانات الفرق محلياً:',e); }
    const el=document.getElementById('loUT'); if(el) el.textContent=new Date().toLocaleTimeString('ar');
}
function loBroadcast(){
    loSave();
    const settings={
        title:document.getElementById('loTournTitle')?.value||'PUBG Championship',
        showCount:parseInt(document.getElementById('loShowCount')?.value||16),
        theme:document.getElementById('loOverlayTheme')?.value||'pubg',
        fontSize:document.getElementById('loFontSize')?.value||'md',
        colVis:loColVis,
        bg:loBgSettings,           /* قد تحتوي فيديو/صور base64 ثقيلة */
        elimBanner:loElimBannerCfg,
        spotlight:loSpotlightCfg,
        teamElimBg:loTeamElimBg,  /* خلفيات إقصاء خاصة بكل فريق — قد تكون ثقيلة أيضاً */
    };

    /* نُخزّن بـ localStorage نسخة خفيفة فقط (بدون بيانات الفيديو/الصور الثقيلة)،
       لأن localStorage محدود بحدود 5-10MB ولو تجاوزناها يرمي خطأ QuotaExceededError
       — وهذا كان يوقف تنفيذ الدالة كاملة قبل الوصول لسطر postMessage بالأسفل،
       فيوقف كل تحديث لاحق (الفيديو، فتح OBS، وإشعار إقصاء الفرق) بشكل صامت. */
    try{
        const lightSettings={...settings, bg:{
            headerBg:settings.bg.headerBg?{type:settings.bg.headerBg.type}:null,
            bodyBg:settings.bg.bodyBg?{type:settings.bg.bodyBg.type}:null,
            elimBannerBg:settings.bg.elimBannerBg?{type:settings.bg.elimBannerBg.type}:null,
            killCardBg:settings.bg.killCardBg?{type:settings.bg.killCardBg.type}:null,
        }, teamElimBg:undefined};
        localStorage.setItem('lo_overlay_settings',JSON.stringify(lightSettings));
    }catch(e){
        console.warn('[loBroadcast] تعذر حفظ الإعدادات محلياً (سيتم إرسالها مباشرة فقط عبر البث):',e);
    }

    /* البث المباشر عبر BroadcastChannel لا يخضع لحدود localStorage الصغيرة،
       ولذلك يبقى المصدر الأساسي والموثوق لنقل الفيديو/الصور لحظة تحديثها */
    try{
        loBc?.postMessage({type:'UPDATE',teams:loTeams,settings,elimOrder:loEliminationOrder});
    }catch(e){
        console.warn('[loBroadcast] فشل إرسال التحديث المباشر:',e);
        loToast('⚠️ تعذر إرسال التحديث — تأكد أن نافذة الأوفرلي مفتوحة بنفس المتصفح','warn');
    }

    /* مزامنة عبر الإنترنت (Firebase) — لأي جهاز ثاني مفتوح عليه أوفرلي/OBS بمكان آخر.
       بيانات خفيفة بس (بدون فيديو/صور خلفية ثقيلة) حتى تبقى سريعة ورخيصة.
       نجمّعها (debounce) بدل إرسال نسخة كاملة مع كل حرف/نقرة: الإرسال المتكرر السريع
       يكوّن طابور رسائل بنفس الاتصال، وكل رسالة قديمة لازم توصل قبل الجديدة — فيبان
       تأخير واضح بالجهاز الثاني (وأسوأ كل ما البعد الجغرافي أكبر). البث المحلي فوق
       (BroadcastChannel) ما يتأثر ويبقى فوري 100%. */
    clearTimeout(_loFbStateTimer);
    _loFbStateTimer=setTimeout(()=>loFirebasePushState(settings), 150);
}
let _loFbStateTimer=null;

/* ════ Firebase — مزامنة الحالة بكسور الثانية بين أي جهازين ════ */
const LO_FB_ROOM='default';
/* يسمح بإرسال كائن الخلفية عبر فايربيس فقط لو رابط حقيقي (https://...) من Storage —
   يمنع تسرّب أي base64/blob ثقيل يوصل بالغلط (فشل رفع، أو خلفية قديمة) لقاعدة البيانات */
function loWebSafeBg(bg){
    return (bg && typeof bg.data==='string' && bg.data.startsWith('http')) ? bg : null;
}
function loFirebasePushState(settings){
    if(!window.loFirebase) return;
    try{
        const{db,ref,set}=window.loFirebase;
        const webSafeBg={
            headerBg:loWebSafeBg(settings.bg?.headerBg),
            bodyBg:loWebSafeBg(settings.bg?.bodyBg),
            elimBannerBg:loWebSafeBg(settings.bg?.elimBannerBg),
            killCardBg:loWebSafeBg(settings.bg?.killCardBg),
        };
        const webSafeTeamElimBg={};
        for(const tid in (settings.teamElimBg||{})){
            const safe=loWebSafeBg(settings.teamElimBg[tid]);
            if(safe) webSafeTeamElimBg[tid]=safe;
        }
        set(ref(db,`rooms/${LO_FB_ROOM}/state`),{
            teams:loTeams.map(t=>({
                id:t.id,name:t.name,abbr:t.abbr,logo:t.logo||null,flag:t.flag||'none',color:t.color,
                kills:t.kills||0,placementPts:t.placementPts||0,place:t.place||null,
                players:(t.players||[]).map(p=>({name:p.name||'',status:p.status||'alive'})),
            })),
            elimOrder:loEliminationOrder,
            settings:{
                title:settings.title, showCount:settings.showCount, theme:settings.theme, fontSize:settings.fontSize,
                colVis:settings.colVis, elimBanner:settings.elimBanner, spotlight:settings.spotlight,
                bg:webSafeBg, teamElimBg:webSafeTeamElimBg,
            },
            updatedAt:Date.now()+(window.loFirebase?.serverTimeOffset||0),
        }).catch(e=>console.warn('[Firebase] فشل رفع الحالة:',e));
    }catch(e){ console.warn('[Firebase] خطأ غير متوقع بالرفع:',e); }
}
function loFirebasePushEvent(type,payload){
    if(!window.loFirebase) return Promise.reject(new Error('no-firebase'));
    try{
        const{db,ref,push,serverTimeOffset}=window.loFirebase;
        const p= push(ref(db,`rooms/${LO_FB_ROOM}/events`),{type,...payload,ts:Date.now()+(serverTimeOffset||0)})
            .catch(e=>{ console.warn('[Firebase] فشل رفع الحدث:',e); throw e; });
        /* ننضّف الأحداث القديمة بين فترة وفترة — لو تركناها تتراكم للأبد (أيام/بطولات)
           راح تصير مسؤولة عن بطء متزايد بكل استعلام/استماع جديد على نفس المسار */
        if(Math.random()<0.1) loFirebasePruneOldEvents();
        return p;
    }catch(e){ console.warn('[Firebase] خطأ غير متوقع بحدث:',e); return Promise.reject(e); }
}
function loFirebasePruneOldEvents(){
    if(!window.loFirebase) return;
    try{
        const{db,ref,query,orderByChild,endAt,onValue,remove,serverTimeOffset}=window.loFirebase;
        const cutoff=Date.now()+(serverTimeOffset||0)-(2*60*60*1000); /* أقدم من ساعتين */
        const oldQuery=query(ref(db,`rooms/${LO_FB_ROOM}/events`), orderByChild('ts'), endAt(cutoff));
        onValue(oldQuery, snap=>{
            snap.forEach(child=>{ remove(child.ref).catch(()=>{}); });
        }, { onlyOnce:true });
    }catch(e){ console.warn('[Firebase] فشل تنظيف الأحداث القديمة:',e); }
}
/* أول ما يجهز Firebase (قد يوصل متأخر عن أول تحميل)، نعيد رفع آخر حالة حتى توصل الأجهزة الثانية */
window.addEventListener('lo-firebase-ready', ()=>{ try{ loBroadcast(); }catch(_){} });
function loTotal(t){ return (t.kills||0)+(t.placementPts||0); }
function loSorted(){ return [...loTeams].sort((a,b)=>loTotal(b)-loTotal(a)); }
function loAllDead(t){ return t.players.every(p=>p.status==='eliminated'); }

/* ════ Tab switching ════ */
function loSwitchTab(tabId,btn){
    document.querySelectorAll('.lo-tab-content').forEach(el=>el.classList.remove('active'));
    document.querySelectorAll('.lo-tab').forEach(b=>b.classList.remove('active'));
    document.getElementById(tabId)?.classList.add('active');
    btn.classList.add('active');
}

/* ════ Source selection ════ */
function loSelectSource(mode,cardId){
    document.querySelectorAll('.lo-source-card').forEach(c=>c.classList.remove('selected'));
    document.getElementById(cardId)?.classList.add('selected');
    loAutoMode=mode;
    /* Update badge */
    const badge=document.getElementById('loModeBadge');
    const dot=document.getElementById('loStatusDot');
    const txt=document.getElementById('loStatusTxt');
    if(mode==='ocr'){
        if(badge) badge.textContent='📷 OCR';
        dot?.classList.remove('manual','error'); dot?.classList.add('live');
        if(txt) txt.textContent='وضع OCR — ارفع screenshot للتحديث';
    } else if(mode==='api'){
        if(badge) badge.textContent='🔗 API';
        if(txt) txt.textContent='وضع API — في انتظار الربط';
    } else {
        if(badge) badge.textContent='⚙️ يدوي';
        dot?.classList.remove('live','error'); dot?.classList.add('manual');
        if(txt) txt.textContent='وضع يدوي';
        clearInterval(loAutoTimer);
    }
}

/* ════ OCR Processing via Claude ════ */
async function loOCRProcess(inp){
    const file=inp.files[0]; if(!file) return;
    document.getElementById('loOcrLbl').textContent='⏳ جاري تحليل الصورة...';

    /* Show preview */
    const reader=new FileReader();
    reader.onload=e=>{
        const prev=document.getElementById('loOcrPreview');
        if(prev){ prev.innerHTML=`<img src="${e.target.result}" style="max-height:180px;width:100%;object-fit:contain;background:#111">`; prev.style.display=''; }
    };
    reader.readAsDataURL(file);

    /* Send to Claude */
    const b64=await new Promise(res=>{
        const r=new FileReader();
        r.onload=e=>res(e.target.result.split(',')[1]);
        r.readAsDataURL(file);
    });

    try{
        const resp=await fetch('https://api.anthropic.com/v1/messages',{
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({
                model:'claude-sonnet-4-20250514',
                max_tokens:1500,
                messages:[{role:'user',content:[
                    {type:'image',source:{type:'base64',media_type:file.type||'image/jpeg',data:b64}},
                    {type:'text',text:`هذه صورة من نتائج لعبة PUBG Mobile أو لعبة Battle Royale أخرى.
استخرج بيانات الفرق من الصورة بدقة تامة.
أعد JSON فقط بدون أي نص آخر، بهذا الشكل:
{
  "teams": [
    {"name": "اسم الفريق", "kills": 5, "points": 8, "placement": 1, "alive": 0},
    ...
  ]
}
حيث:
- name: اسم الفريق أو الفريق كما هو مكتوب في الصورة
- kills: عدد القتلات (رقم)
- points: النقاط الكلية إن وجدت، وإلا 0
- placement: ترتيب الفريق (1 = أول)
- alive: عدد اللاعبين الأحياء (عادة 0 بعد انتهاء الروم، أو 1-4 خلاله)
إذا كانت الصورة خلال الكيم وليس في النهاية، حدد alive بناءً على الصورة.
استخرج كل الفرق الظاهرة.`}
                ]}]
            })
        });
        const data=await resp.json();
        const txt=data.content?.[0]?.text||'{}';
        let parsed={};
        try{ parsed=JSON.parse(txt.replace(/```json?|```/g,'').trim()); }catch(_){}

        if(parsed.teams?.length){
            loApplyOCRData(parsed.teams);
            document.getElementById('loOcrLbl').textContent=`✅ تم قراءة ${parsed.teams.length} فريق`;
            const res=document.getElementById('loOcrResult');
            if(res){
                res.style.display='';
                res.innerHTML=`<div style="background:rgba(68,238,85,.1);border:1px solid rgba(68,238,85,.25);border-radius:8px;padding:.5rem .7rem;color:#44ee55;font-size:.78rem">
                    ✅ تم استخراج <b>${parsed.teams.length}</b> فريق من الصورة وتحديث الجدول تلقائياً
                    <br><span style="color:#667;font-size:.7rem">آخر تحديث: ${new Date().toLocaleTimeString('ar')}</span>
                </div>`;
            }
            /* Switch to teams tab */
            document.querySelector('[data-tab="loTeamsTab"]')?.click();
            loToast(`✅ تم قراءة ${parsed.teams.length} فريق من الصورة!`,'ok');
        } else {
            throw new Error('لم يتم العثور على بيانات فرق');
        }
    }catch(e){
        document.getElementById('loOcrLbl').textContent='❌ تعذّر قراءة الصورة — تأكد من وضوح الصورة';
        loToast('❌ '+e.message,'error');
    }
}

function loApplyOCRData(teams){
    /* Match or create teams */
    teams.forEach((t,i)=>{
        const existing=loTeams.find(lt=>lt.name.toLowerCase()===t.name.toLowerCase());
        if(existing){
            existing.kills=t.kills||0;
            if(t.points) existing.placementPts=t.points;
            if(t.placement) existing.place=t.placement;
            if(t.alive!==undefined){
                const alive=parseInt(t.alive)||0;
                existing.players=existing.players.map((p,pi)=>({name:p.name,status:pi<alive?'alive':'eliminated'}));
            }
        } else {
            const colors=['#ff4444','#44aaff','#44ff88','#ffaa00','#aa44ff','#ff44aa','#44ffff','#ffff44','#ff8800','#88ff00','#00ffaa','#ff00aa','#aaaaff','#ff8888','#88aaff','#aaff88'];
            const alive=parseInt(t.alive)||0;
            const players=Array.from({length:4},(_,pi)=>({name:'',status:pi<alive?'alive':'eliminated'}));
            loTeams.push({
                id:loNextId++,
                name:t.name||`Team ${loTeams.length+1}`,
                abbr:(t.name||'T').slice(0,4).toUpperCase(),
                flag:'none', color:colors[loTeams.length%colors.length], logo:null,
                players, kills:t.kills||0, placementPts:t.points||0, place:t.placement||null
            });
        }
    });
    loRenderTable();
    loBroadcast();
}

/* ════ PUBG API Integration ════ */
async function loAPIConnect(){
    const key=document.getElementById('loApiKey')?.value?.trim();
    const name=document.getElementById('loPlayerName')?.value?.trim();
    const shard=document.getElementById('loShard')?.value||'steam';
    if(!key||!name){ loToast('⚠️ أدخل API Key واسم اللاعب','warn'); return; }

    /* Save config */
    localStorage.setItem('lo_config',JSON.stringify({apiKey:key,playerName:name,shard}));
    loApiKey=key; loPlayerName=name;

    const statusEl=document.getElementById('loAPIStatus');
    if(statusEl) statusEl.innerHTML='<div style="color:#aaa;font-size:.78rem;margin-top:.4rem">⏳ جاري البحث عن آخر مباراة...</div>';

    /* Fetch player data */
    try{
        const res=await fetch(`https://api.pubg.com/shards/${shard}/players?filter[playerNames]=${encodeURIComponent(name)}`,{
            headers:{ 'Authorization':'Bearer '+key, 'Accept':'application/vnd.api+json' }
        });
        if(!res.ok) throw new Error(`API خطأ ${res.status}: ${res.statusText}`);
        const data=await res.json();
        const player=data.data?.[0];
        if(!player) throw new Error('اللاعب غير موجود');

        const playerId=player.id;
        const matches=player.relationships?.matches?.data;
        if(!matches?.length) throw new Error('لا توجد مباريات');

        /* Fetch latest match */
        await loFetchMatch(matches[0].id,shard,key);

        /* Auto-refresh every 90s */
        clearInterval(loAutoTimer);
        loAutoTimer=setInterval(async()=>{
            try{
                const r2=await fetch(`https://api.pubg.com/shards/${shard}/players/${playerId}`,{
                    headers:{'Authorization':'Bearer '+key,'Accept':'application/vnd.api+json'}
                });
                const d2=await r2.json();
                const newMatches=d2.data?.relationships?.matches?.data;
                if(newMatches?.length&&newMatches[0].id!==loLastMatchId){
                    await loFetchMatch(newMatches[0].id,shard,key);
                    loToast('🔄 تم تحديث البيانات من آخر كيم!','ok');
                }
            }catch(_){}
        },90_000);

        const dot=document.getElementById('loStatusDot');
        dot?.classList.remove('manual','error'); dot?.classList.add('live');
        document.getElementById('loStatusTxt').textContent='🔗 API متصل — تحديث كل 90 ثانية';
        if(statusEl) statusEl.innerHTML='<div style="background:rgba(68,238,85,.1);border:1px solid rgba(68,238,85,.25);border-radius:8px;padding:.5rem .7rem;color:#44ee55;font-size:.78rem;margin-top:.4rem">✅ متصل! يراقب مباريات: '+name+'</div>';
    }catch(e){
        if(statusEl) statusEl.innerHTML=`<div style="background:rgba(255,68,68,.1);border:1px solid rgba(255,68,68,.25);border-radius:8px;padding:.5rem .7rem;color:#f88;font-size:.78rem;margin-top:.4rem">❌ ${e.message}</div>`;
        loToast('❌ '+e.message,'error');
    }
}

async function loFetchMatch(matchId,shard,key){
    loLastMatchId=matchId;
    const res=await fetch(`https://api.pubg.com/shards/${shard}/matches/${matchId}`,{
        headers:{'Authorization':'Bearer '+key,'Accept':'application/vnd.api+json'}
    });
    if(!res.ok) throw new Error(`فشل جلب المباراة: ${res.status}`);
    const data=await res.json();

    /* Parse participants and rosters */
    const participants={};
    data.included?.filter(i=>i.type==='participant').forEach(p=>{
        participants[p.id]={
            name:p.attributes.stats.name,
            kills:p.attributes.stats.kills||0,
            damage:Math.round(p.attributes.stats.damageDealt||0),
            survived:p.attributes.stats.timeSurvived||0,
        };
    });

    const rosters=data.included?.filter(i=>i.type==='roster')||[];
    const matchTeams=rosters.map(r=>({
        placement:r.attributes.stats.rank||0,
        members:r.relationships?.participants?.data?.map(p=>participants[p.id])||[],
    })).filter(r=>r.members.length>0);

    /* Map to loTeams */
    matchTeams.forEach(team=>{
        const teamName=team.members.map(m=>m.name).join(' / ');
        const kills=team.members.reduce((s,m)=>s+m.kills,0);
        const pts=LO_PLACEMENT[team.placement]||0;
        const existing=loTeams.find(lt=>team.members.some(m=>lt.name.toLowerCase().includes(m.name.toLowerCase())));
        if(existing){
            existing.kills=kills; existing.placementPts=pts; existing.place=team.placement;
            existing.players=existing.players.map((p,pi)=>({name:team.members[pi]?.name||p.name,status:'eliminated'}));
        } else {
            const colors=['#ff4444','#44aaff','#44ff88','#ffaa00','#aa44ff','#ff44aa'];
            loTeams.push({
                id:loNextId++, name:teamName, abbr:team.members[0]?.name?.slice(0,4).toUpperCase()||'TM',
                flag:'none', color:colors[loTeams.length%colors.length], logo:null,
                players:Array.from({length:4},(_,pi)=>({name:team.members[pi]?.name||'',status:'eliminated'})),
                kills, placementPts:pts, place:team.placement,
            });
        }
    });
    loRenderTable(); loBroadcast();
}

/* ════ Render Teams Table ════ */
function loRenderTable(){
    const tbody=document.getElementById('loTbody'); if(!tbody) return;
    const sorted=loSorted();
    tbody.innerHTML=sorted.map((t,i)=>{
        const rank=i+1, pts=loTotal(t);
        const elimIdx=loEliminationOrder.indexOf(t.id);
        const rowCls=rank===1?'lo-top1':rank===2?'lo-top2':rank===3?'lo-top3':'';
        const flagOpts=LO_FLAGS.map(f=>`<option value="${f.code}"${f.code===(t.flag||'none')?' selected':''}>${f.emoji} ${f.label}</option>`).join('');
        const bars=t.players.map((p,pi)=>`<div class="lo-pbar ${p.status}" onclick="loTogP(${t.id},${pi})" title="${p.name||('لاعب '+(pi+1))} — ${{alive:'حي',knocked:'نوك',eliminated:'ميت'}[p.status]}"></div>`).join('');
        const elBadge=elimIdx>=0?`<span class="lo-elim-b" title="مات ${elimIdx+1}°">${elimIdx+1}</span>`:`<span class="lo-alive-b">●</span>`;
        const plBadge=t.place?`<button class="lo-place-b" onclick="loOpenPlace(${t.id},${rank})">${rank<=3?['🥇','🥈','🥉'][rank-1]:'#'+t.place} +${t.placementPts||0}</button>`:`<button class="lo-place-b no-p" onclick="loOpenPlace(${t.id},${rank})">📍</button>`;
        const logoHtml=t.logo?`<img src="${t.logo}" style="width:26px;height:26px;border-radius:6px;object-fit:cover">`:`<i class="fas fa-image" style="color:#334455"></i>`;
        return `<tr id="lor-${t.id}">
          <td class="lo-rank" data-col="rank">${rank}</td>
          <td style="text-align:center" data-col="elim">${elBadge}</td>
          <td style="text-align:center" data-col="logo">
            <div style="cursor:pointer;width:26px;height:26px;display:flex;align-items:center;justify-content:center;border:1px dashed rgba(0,229,255,.25);border-radius:6px;margin:0 auto" onclick="document.getElementById('loLogoInp_${t.id}').click()">${logoHtml}</div>
            <input type="file" id="loLogoInp_${t.id}" accept="image/*" style="display:none" onchange="loSetLogo(${t.id},this)">
          </td>
          <td style="text-align:center" data-col="flag">
            <div style="display:flex;flex-direction:column;align-items:center;gap:3px">
              <img class="lo-flag-preview" src="https://flagcdn.com/w40/${t.flag&&t.flag!=='none'?t.flag:'xx'}.png" style="width:22px;height:16px;object-fit:cover;border-radius:3px;${!t.flag||t.flag==='none'?'display:none':''}" onerror="this.style.display='none'">
              <select class="lo-flag-sel" onchange="loF(${t.id},'flag',this.value)" title="علم الفريق">${flagOpts}</select>
            </div>
          </td>
          <td style="text-align:center" data-col="color"><input type="color" value="${t.color}" oninput="loF(${t.id},'color',this.value)" style="width:28px;height:26px;border:none;border-radius:6px;cursor:pointer;background:none;padding:0"></td>
          <td data-col="name"><input class="lo-name-inp" value="${t.name.replace(/"/g,'&quot;')}" oninput="loF(${t.id},'name',this.value)"></td>
          <td data-col="abbr"><input class="lo-abbr-inp" value="${t.abbr}" maxlength="5" oninput="loF(${t.id},'abbr',this.value.toUpperCase())"></td>
          <td data-col="players">
            <div class="lo-players">${bars}</div>
            <button class="lo-players-edit" onclick="loOpenPlayerNames(${t.id})" title="أسماء اللاعبين"><i class="fas fa-user-edit"></i></button>
          </td>
          <td data-col="kills">
            <div class="lo-kills-v2">
              <span class="lo-kill-val" onclick="loEditKillsDirect(${t.id})" title="اضغط للتعديل اليدوي">${t.kills||0}</span>
              <div class="lo-kill-actions">
                <button class="lo-ka-btn kill" onclick="loOpenKillTeamPicker(${t.id},'kill')">☠️ قتل</button>
                <button class="lo-ka-btn knock" onclick="loOpenKillTeamPicker(${t.id},'knock')">🎯 نوك</button>
              </div>
            </div>
          </td>
          <td style="text-align:center" data-col="place">${plBadge}</td>
          <td data-col="total"><span class="lo-total" style="color:${rank===1?'#ffd700':rank<=3?'#00e5ff':'#ccc'}">${pts}</span></td>
          <td style="display:flex;gap:4px;align-items:center;justify-content:center;white-space:nowrap">
            <button class="lo-eb-team-btn ${loTeamElimBg[t.id]?'has':''}" onclick="loOpenTeamElimBg(${t.id})" title="خلفية إقصاء خاصة بهذا الفريق">🎬</button>
            <button class="lo-del-btn" onclick="loDel(${t.id})">✕</button>
          </td>
        </tr>`;
    }).join('');
    const ec=document.getElementById('loEC'),tc=document.getElementById('loTC'),tp=document.getElementById('loUT');
    if(ec) ec.textContent=loEliminationOrder.length;
    if(tc) tc.textContent=loTeams.length;
    loApplyColVis();
}

/* ════ شعار الفريق ════ */
function loSetLogo(tid,inp){
    const file=inp.files[0]; if(!file) return;
    const r=new FileReader();
    r.onload=e=>{ const t=loTeams.find(t=>t.id===tid); if(t){ t.logo=e.target.result; loRenderTable(); loBroadcast(); } };
    r.readAsDataURL(file);
}

/* ════ أسماء اللاعبين (حتى 4) ════ */
function loOpenPlayerNames(tid){
    const t=loTeams.find(t=>t.id===tid); if(!t) return;
    document.getElementById('lo-pnames-popup')?.remove();
    const pop=document.createElement('div');
    pop.id='lo-pnames-popup';
    pop.className='lo-place-popup';
    pop.style.minWidth='260px';
    pop.innerHTML=`<h4>👥 أسماء لاعبي ${t.name}</h4>
        <div style="display:flex;flex-direction:column;gap:.5rem">
            ${t.players.map((p,pi)=>`<input class="lo-inp" placeholder="اسم اللاعب ${pi+1}" value="${(p.name||'').replace(/"/g,'&quot;')}" oninput="loSetPlayerName(${tid},${pi},this.value)">`).join('')}
        </div>
        <button class="lo-pl-cancel" style="background:rgba(68,238,85,.12);border-color:rgba(68,238,85,.25);color:#44ee55;margin-top:.6rem" onclick="document.getElementById('lo-pnames-popup')?.remove();loRenderTable();loBroadcast();">✅ تم</button>`;
    document.body.appendChild(pop);
}
function loSetPlayerName(tid,pi,val){
    const t=loTeams.find(t=>t.id===tid); if(!t) return;
    t.players[pi].name=val;
}

/* ════ إظهار/إخفاء الأعمدة ════ */
function loApplyColVis(){
    const table=document.getElementById('loTable'); if(!table) return;
    Object.keys(loColVis).forEach(col=>{
        table.querySelectorAll(`[data-col="${col}"]`).forEach(el=>{
            el.style.display=loColVis[col]?'':'none';
        });
    });
}
function loToggleCol(col,checked){
    loColVis[col]=checked?1:0;
    localStorage.setItem('lo_colvis',JSON.stringify(loColVis));
    loApplyColVis();
    loBroadcast();
}
function loSyncColVisUI(){
    Object.keys(loColVis).forEach(col=>{
        const el=document.getElementById('loCv_'+col);
        if(el) el.checked=!!loColVis[col];
    });
}

/* ════ نقاط المراكز — قابلة للتعديل من لوحة التحكم ════ */
function loSyncPlacementUI(){
    const grid=document.getElementById('loPlacementGrid'); if(!grid) return;
    const maxPlace=LO_PLACEMENT.length-1;
    grid.innerHTML=Array.from({length:maxPlace},(_,i)=>i+1).map(p=>
        `<div class="lo-placement-item">
            <label>#${p}</label>
            <input type="number" min="0" value="${LO_PLACEMENT[p]||0}" onchange="loSetPlacementPoint(${p},this.value)">
        </div>`
    ).join('');
}
function loSetPlacementPoint(place,val){
    const pts=Math.max(0,parseInt(val)||0);
    LO_PLACEMENT[place]=pts;
    localStorage.setItem('lo_placement_points',JSON.stringify(LO_PLACEMENT));
    /* أي فريق مصنّف حالياً بهذا المركز يتحدث فوراً */
    loTeams.forEach(t=>{ if(t.place===place) t.placementPts=pts; });
    loRenderTable();
    loBroadcast();
}

/* ════ Actions ════ */
function loTogP(tid,pi){
    const t=loTeams.find(t=>t.id===tid); if(!t) return;
    const wasAllDead=loAllDead(t);
    const cycle={alive:'knocked',knocked:'eliminated',eliminated:'alive'};
    t.players[pi].status=cycle[t.players[pi].status]||'alive';
    const allDead=loAllDead(t);

    if(allDead&&!wasAllDead&&!loEliminationOrder.includes(tid)){
        loEliminationOrder.push(tid);
        loAutoPlaceOnElim(t);
        loAnnounceElimination(t);
    } else if(!allDead&&loEliminationOrder.includes(tid)){
        loEliminationOrder=loEliminationOrder.filter(id=>id!==tid);
        t.placementPts=0; t.place=null;
    }
    loRenderTable(); loBroadcast();
}

/* حساب المركز تلقائياً لحظة إقصاء الفريق بالكامل
   المركز = عدد الفرق الحية المتبقية + 1  (مثال: باقي 10 أحياء ← هذا الفريق مركز 11) */
function loAutoPlaceOnElim(t){
    const aliveCount=loTeams.filter(tm=>!loEliminationOrder.includes(tm.id)).length;
    const place=aliveCount+1;
    t.place=place;
    t.placementPts=LO_PLACEMENT[place]||0;
}

/* إرسال حدث إقصاء لعرضه كبانر بشاشة الأوفرلي — reason اختياري (مثلاً "مخالفة القوانين") */
function loAnnounceElimination(t,reason){
    const payload={ id:t.id, name:t.name, abbr:t.abbr, logo:t.logo, flag:t.flag, color:t.color, kills:t.kills||0, place:t.place, reason:reason||null };
    try{
        loBc?.postMessage({ type:'TEAM_ELIMINATED', team:payload });
    }catch(_){}
    loFirebasePushEvent('TEAM_ELIMINATED', {team:payload}).catch(()=>{});
    loToast(reason?`🚫 ${t.name} أُقصي — ${reason} — المركز #${t.place}`:`☠️ ${t.name} تم إقصاؤه — المركز #${t.place}`,'warn');
}

/* ════ إقصاء يدوي لمخالفة القوانين — يختار المستخدم الفريق ويُقصى فوراً بغض النظر عن حالة اللاعبين ════ */
function loOpenDisqualifyPicker(){
    document.getElementById('lo-dq-picker-popup')?.remove();
    if(!loTeams.length){ loToast('⚠️ ماكو فرق بعد','warn'); return; }
    const pop=document.createElement('div');
    pop.id='lo-dq-picker-popup';
    pop.className='lo-place-popup';
    pop.style.minWidth='270px';
    pop.innerHTML=`<h4>🚫 إقصاء لمخالفة القوانين — اختر الفريق</h4>
        <div class="lo-kill-picker-list">
            ${loTeams.map(t=>`<button class="lo-kill-picker-item" style="border-color:${t.color||'#888'}" onclick="loDisqualifyTeam(${t.id})">
                <span class="lo-kpi-dot" style="background:${t.color||'#888'}"></span>
                <span class="lo-kpi-name">${t.name}</span>
            </button>`).join('')}
        </div>
        <button class="lo-pl-cancel" onclick="document.getElementById('lo-dq-picker-popup')?.remove()">إلغاء</button>`;
    document.body.appendChild(pop);
}
function loDisqualifyTeam(tid){
    document.getElementById('lo-dq-picker-popup')?.remove();
    const t=loTeams.find(tm=>tm.id===tid); if(!t) return;
    t.players.forEach(p=>p.status='eliminated');
    if(!loEliminationOrder.includes(tid)){
        loEliminationOrder.push(tid);
        loAutoPlaceOnElim(t);
    }
    loAnnounceElimination(t,'مخالفة القوانين');
    loRenderTable(); loBroadcast();
}

/* كارد قتلة مفردة — بنفس ستايل شاشة اللعبة الأصلية (شعار + اسم الفريق + اللاعب + الضرر + المسافة) */
function loAnnounceKillCard(vTeam,playerName,damage,distance,airdrops,kTeam,mode,count){
    const payload={
        team:{ id:vTeam.id, name:vTeam.name, abbr:vTeam.abbr, logo:vTeam.logo, flag:vTeam.flag, color:vTeam.color },
        killer: kTeam ? { id:kTeam.id, name:kTeam.name, abbr:kTeam.abbr, logo:kTeam.logo, flag:kTeam.flag, color:kTeam.color } : null,
        mode: mode||'kill',
        count: count||1,
        player:playerName||'',
        damage:damage??null,
        distance:distance??null,
        airdrops:airdrops??null,
    };
    try{
        loBc?.postMessage({ type:'PLAYER_KILLED', ...payload });
    }catch(_){}
    loFirebasePushEvent('PLAYER_KILLED', payload).catch(()=>{});
}

/* إضافة قتلة — مع قفل مؤقت لمنع الضغط بالخطأ على فريق آخر بعد تغيّر ترتيب الجدول */
const LO_KILL_LOCK_MS=1300;
function loK(tid,d){
    const t=loTeams.find(t=>t.id===tid); if(!t) return;
    const now=Date.now();
    if(d>0){
        if(loKillLockTid!==null && loKillLockTid!==tid && now<loKillLockUntil){
            loToast('⏳ انتظر لحظة قبل إضافة نقطة لفريق آخر','warn');
            return;
        }
        loKillLockTid=tid; loKillLockUntil=now+LO_KILL_LOCK_MS;
        setTimeout(()=>{ if(Date.now()>=loKillLockUntil){ loKillLockTid=null; loRenderTable(); } },LO_KILL_LOCK_MS+40);
    }
    t.kills=Math.max(0,(t.kills||0)+d);
    loRenderTable(); loBroadcast();
}

/* نافذة اختيار "من أي فريق" — الخطوة الأولى، تشتغل لوضعي قتل ونوك */
function loOpenKillTeamPicker(killerTid,mode){
    const kTeam=loTeams.find(t=>t.id===killerTid); if(!kTeam) return;
    document.getElementById('lo-kill-picker-popup')?.remove();
    const others=loTeams.filter(t=>t.id!==killerTid);
    if(!others.length){ loToast('⚠️ ماكو فرق ثانية بعد','warn'); return; }
    const isKill=mode==='kill';

    const pop=document.createElement('div');
    pop.id='lo-kill-picker-popup';
    pop.className='lo-place-popup';
    pop.style.minWidth='270px';
    pop.innerHTML=`<h4>${isKill?'☠️ قتل':'🎯 نوك'} — فريق ${kTeam.name} — من أي فريق؟</h4>
        <div class="lo-kill-picker-list">
            ${others.map(t=>{
                const avail=isKill
                    ? t.players.filter(p=>p.status!=='eliminated').length
                    : t.players.filter(p=>p.status==='alive').length;
                const disabled=avail===0;
                return `<button class="lo-kill-picker-item" ${disabled?'disabled':''} style="border-color:${t.color||'#888'}${disabled?'44':''}" onclick="loOpenKillCountPicker(${killerTid},${t.id},'${mode}')">
                    <span class="lo-kpi-dot" style="background:${t.color||'#888'}"></span>
                    <span class="lo-kpi-name">${t.name}</span>
                    <span class="lo-kpi-count">${disabled?'ماكو متاح':avail+' متاح'}</span>
                </button>`;
            }).join('')}
        </div>
        <button class="lo-pl-cancel" onclick="document.getElementById('lo-kill-picker-popup')?.remove()">إلغاء</button>`;
    document.body.appendChild(pop);
}

/* الخطوة الثانية — كم نفر بنفس اللحظة (1 إلى 4) */
function loOpenKillCountPicker(killerTid,victimTid,mode){
    const kTeam=loTeams.find(t=>t.id===killerTid);
    const vTeam=loTeams.find(t=>t.id===victimTid);
    if(!kTeam||!vTeam) return;
    document.getElementById('lo-kill-picker-popup')?.remove();
    const isKill=mode==='kill';

    const avail=isKill
        ? vTeam.players.filter(p=>p.status!=='eliminated').length
        : vTeam.players.filter(p=>p.status==='alive').length;
    if(avail===0){ loToast('⚠️ ماكو لاعبين متاحين بفريق '+vTeam.abbr,'warn'); return; }
    const maxCount=Math.min(4,avail);

    /* الضرر والمسافة والإسقاطات اختياريين — يطلعون بس بوضع "قتل" لبناء كارد شبيه بكارد اللعبة الأصلي */
    const extraFieldsHtml = isKill ? `
        <div style="display:flex;gap:.4rem;margin-bottom:.7rem">
            <div class="lo-fgroup" style="flex:1;margin:0">
                <label class="lo-label" style="font-size:.65rem">💥 الضرر</label>
                <input type="number" class="lo-inp" id="loKcDamage" min="0" placeholder="177">
            </div>
            <div class="lo-fgroup" style="flex:1;margin:0">
                <label class="lo-label" style="font-size:.65rem">📏 المسافة م</label>
                <input type="number" class="lo-inp" id="loKcDistance" min="0" placeholder="203">
            </div>
            <div class="lo-fgroup" style="flex:1;margin:0">
                <label class="lo-label" style="font-size:.65rem">📦 إسقاطات</label>
                <input type="number" class="lo-inp" id="loKcAirdrops" min="0" placeholder="0">
            </div>
        </div>` : '';

    const pop=document.createElement('div');
    pop.id='lo-kill-picker-popup';
    pop.className='lo-place-popup';
    pop.style.minWidth='260px';
    pop.innerHTML=`<h4>${isKill?'☠️ قتل':'🎯 نوك'} — كم نفر من ${vTeam.name}؟</h4>
        ${extraFieldsHtml}
        <div class="lo-kill-count-row">
            ${[1,2,3,4].map(n=>`<button class="lo-kill-count-btn" ${n>maxCount?'disabled':''} onclick="loApplyTeamAction(${killerTid},${victimTid},'${mode}',${n})">${n}</button>`).join('')}
        </div>
        <button class="lo-pl-cancel" style="margin-top:.6rem" onclick="document.getElementById('lo-kill-picker-popup')?.remove()">◀ رجوع</button>`;
    document.body.appendChild(pop);
}

/* تطبيق العدد المختار فوراً — قتل ينقّص ويقصي، نوك ينوّك بس (بدون إقصاء ولا نقطة كل) */
function loApplyTeamAction(killerTid,victimTid,mode,count){
    const isKill=mode==='kill';
    /* نقرا الضرر/المسافة من الحقول قبل ما نحذف النافذة */
    const damage = isKill ? (parseInt(document.getElementById('loKcDamage')?.value)||null) : null;
    const distance = isKill ? (parseInt(document.getElementById('loKcDistance')?.value)||null) : null;
    const airdropsRaw = isKill ? parseInt(document.getElementById('loKcAirdrops')?.value) : NaN;
    const airdrops = !isNaN(airdropsRaw) ? airdropsRaw : null;
    document.getElementById('lo-kill-picker-popup')?.remove();
    const kTeam=loTeams.find(t=>t.id===killerTid);
    const vTeam=loTeams.find(t=>t.id===victimTid);
    if(!kTeam||!vTeam) return;

    const affected=[]; /* [{pi, prevStatus}] لدعم التراجع */
    for(let i=0;i<count;i++){
        let pi;
        if(isKill){
            pi=vTeam.players.findIndex(p=>p.status==='knocked'); /* أولوية لمن هو منوّك أصلاً */
            if(pi===-1) pi=vTeam.players.findIndex(p=>p.status==='alive');
        } else {
            pi=vTeam.players.findIndex(p=>p.status==='alive');
        }
        if(pi===-1) break;
        affected.push({pi,prevStatus:vTeam.players[pi].status});
        vTeam.players[pi].status=isKill?'eliminated':'knocked';
    }
    if(!affected.length){ loToast('⚠️ ماكو لاعبين متاحين','warn'); return; }

    const wasAlreadyElim=loEliminationOrder.includes(vTeam.id);
    if(isKill) loKDirect(killerTid,affected.length);

    const allDead=loAllDead(vTeam);
    if(allDead&&!loEliminationOrder.includes(vTeam.id)){
        loEliminationOrder.push(vTeam.id);
        loAutoPlaceOnElim(vTeam);
        loAnnounceElimination(vTeam);
    }
    loRenderTable(); loBroadcast();

    if(isKill){
        const lastAffectedPlayer = vTeam.players[affected[affected.length-1].pi];
        loAnnounceKillCard(vTeam, lastAffectedPlayer?.name||'', damage, distance, airdrops, kTeam, 'kill', affected.length);
    } else {
        loAnnounceKillCard(vTeam, '', null, null, null, kTeam, 'knock', affected.length);
    }

    const label=isKill
        ? `☠️ قتل ${affected.length} من ${vTeam.abbr} (+${affected.length} لـ${kTeam.abbr})`
        : `🎯 نوك ${affected.length} من ${vTeam.abbr}`;
    loActionToast(label, ()=>loUndoTeamAction(killerTid,victimTid,affected,isKill,wasAlreadyElim));
}
function loUndoTeamAction(killerTid,victimTid,affected,isKill,wasAlreadyElim){
    const kTeam=loTeams.find(t=>t.id===killerTid);
    const vTeam=loTeams.find(t=>t.id===victimTid);
    if(!vTeam) return;
    affected.forEach(a=>{ if(vTeam.players[a.pi]) vTeam.players[a.pi].status=a.prevStatus; });
    if(isKill&&kTeam) loKDirect(killerTid,-affected.length);
    if(!wasAlreadyElim){
        const idx=loEliminationOrder.indexOf(victimTid);
        if(idx>-1) loEliminationOrder.splice(idx,1);
    }
    loRenderTable(); loBroadcast();
    loToast('↩️ تم التراجع','info');
}

/* تعديل يدوي مباشر لعدد الكلات (لو تحتاج تصحيح شي ماكو بالسيناريوهين أعلاه) */
function loEditKillsDirect(tid){
    const t=loTeams.find(t=>t.id===tid); if(!t) return;
    const v=prompt('عدد كلات '+t.name+':', t.kills||0);
    if(v===null) return;
    const n=parseInt(v);
    if(isNaN(n)||n<0){ loToast('⚠️ رقم غير صالح','warn'); return; }
    t.kills=n;
    loRenderTable(); loBroadcast();
}

function loF(tid,f,v){ const t=loTeams.find(t=>t.id===tid); if(t) t[f]=v; loBroadcast(); }
function loDel(tid){ loTeams=loTeams.filter(t=>t.id!==tid); loEliminationOrder=loEliminationOrder.filter(id=>id!==tid); loRenderTable(); loBroadcast(); }

function loAddTeam(){
    const c=['#ff4444','#44aaff','#44ff88','#ffaa00','#aa44ff','#ff44aa','#44ffff','#ffff44'];
    loTeams.push({
        id:loNextId++, name:`Team ${loTeams.length+1}`, abbr:`T${loTeams.length+1}`,
        flag:'none', color:c[loTeams.length%c.length], logo:null,
        players:Array.from({length:4},()=>({name:'',status:'alive'})),
        kills:0, placementPts:0, place:null,
    });
    loRenderTable(); loBroadcast();
}

function loNewRound(){
    if(!confirm('جولة جديدة؟')) return;
    loTeams.forEach(t=>{ t.players=Array.from({length:4},(_,i)=>({name:t.players[i]?.name||'',status:'alive'})); t.kills=0; t.placementPts=0; t.place=null; });
    loEliminationOrder=[];
    loRenderTable(); loBroadcast();
}
function loReset(){ if(!confirm('مسح كل البيانات؟')) return; loTeams=loDefaultTeams(); loEliminationOrder=[]; loNextId=loTeams.length+1; loRenderTable(); loBroadcast(); }
function loOpenOverlay(){
    try{ loBroadcast(); }catch(e){ console.warn('[loOpenOverlay] فشل البث قبل الفتح (سيتابع الفتح على أي حال):',e); }
    const url=new URL('live-overlay.html',window.location.href).href;
    const w=window.open(url,'pubg-overlay','width=520,height=720');
    if(!w) alert('فعّل النوافذ المنبثقة أو اسحب live-overlay.html إلى OBS');
}
/* نافذة منفصلة شفافة بالكامل — تخص عرض الفرق المتبقية فقط، تُضاف كمصدر OBS مستقل */
function loOpenSpotlightWindow(){
    try{ loBroadcast(); }catch(e){ console.warn('[loOpenSpotlightWindow] فشل البث قبل الفتح:',e); }
    const url=new URL('live-spotlight.html',window.location.href).href;
    const w=window.open(url,'pubg-spotlight','width=900,height=400');
    if(!w) alert('فعّل النوافذ المنبثقة أو اسحب live-spotlight.html إلى OBS كمصدر منفصل');
    else loToast('🎯 فتحت نافذة الفرق المتبقية — اسحبها كمصدر Browser Source منفصل بـ OBS','info');
}
/* نافذة منفصلة شفافة بالكامل — تخص كارد القتلة المفردة فقط، ماله أي علاقة بجدول الفرق */
function loOpenKillCardWindow(){
    const url=new URL('live-killcard.html',window.location.href).href;
    const w=window.open(url,'pubg-killcard','width=500,height=180');
    if(!w) alert('فعّل النوافذ المنبثقة أو اسحب live-killcard.html إلى OBS كمصدر منفصل');
    else loToast('💀 فتحت نافذة كارد القتلة — اسحبها كمصدر Browser Source منفصل بـ OBS','info');
}

/* ════ إعدادات بانر إشعار الإقصاء — مكان حر بالسحب + حجم ════ */
function loSaveEbCfg(){ try{ localStorage.setItem('lo_elim_banner_cfg',JSON.stringify(loElimBannerCfg)); }catch(_){} }
function loSetEbPreset(xPct,yPct){
    loElimBannerCfg.xPct=xPct; loElimBannerCfg.yPct=yPct;
    loSyncEbUI();
    loSaveEbCfg();
    loBroadcast();
}
function loSetEbScale(v){
    loElimBannerCfg.scale=(+v)/100;
    const el=document.getElementById('loEbScaleVal'); if(el) el.textContent=v+'%';
    loSaveEbCfg();
    loBroadcast();
}
function loSyncEbUI(){
    const marker=document.getElementById('loEbDragMarker');
    if(marker){ marker.style.left=loElimBannerCfg.xPct+'%'; marker.style.top=loElimBannerCfg.yPct+'%'; }
    const sl=document.getElementById('loEbScale'); if(sl) sl.value=Math.round(loElimBannerCfg.scale*100);
    const lb=document.getElementById('loEbScaleVal'); if(lb) lb.textContent=Math.round(loElimBannerCfg.scale*100)+'%';
}
/* سحب مؤشّر المكان داخل منطقة معاينة الشاشة (16:9) — يحسب %x/%y ويحفظ فوراً */
let loEbDragging=false;
function loEbDragStart(ev){
    loEbDragging=true;
    loEbDragMove(ev);
    ev.preventDefault();
}
function loEbDragMove(ev){
    if(!loEbDragging) return;
    const zone=document.getElementById('loEbDragZone'); if(!zone) return;
    const rect=zone.getBoundingClientRect();
    const point=ev.touches?ev.touches[0]:ev;
    let xPct=((point.clientX-rect.left)/rect.width)*100;
    let yPct=((point.clientY-rect.top)/rect.height)*100;
    xPct=Math.max(2,Math.min(98,xPct));
    yPct=Math.max(2,Math.min(98,yPct));
    loElimBannerCfg.xPct=Math.round(xPct);
    loElimBannerCfg.yPct=Math.round(yPct);
    const marker=document.getElementById('loEbDragMarker');
    if(marker){ marker.style.left=loElimBannerCfg.xPct+'%'; marker.style.top=loElimBannerCfg.yPct+'%'; }
    loBroadcast();
}
function loEbDragEnd(){
    if(!loEbDragging) return;
    loEbDragging=false;
    loSaveEbCfg();
}
document.addEventListener('mousemove', loEbDragMove);
document.addEventListener('mouseup', loEbDragEnd);
document.addEventListener('touchmove', loEbDragMove, {passive:false});
document.addEventListener('touchend', loEbDragEnd);

/* يرسل إشعار إقصاء تجريبي لمعاينة الشكل/المكان/الحجم بدون الحاجة لموت فريق فعلياً */
async function loTestElimBanner(){
    const testTeam={id:-1,name:'فريق تجريبي',abbr:'TST',logo:null,flag:'none',color:'#ff4444',kills:7,place:5};
    try{ loBc?.postMessage({type:'TEAM_ELIMINATED',team:testTeam}); }catch(_){}

    if(!window.loFirebase){
        loToast('⚠️ فايربيس غير متصل بهذا الجهاز — الإشعار راح يوصل لنفس الجهاز بس، مو للجهاز الثاني','warn');
        return;
    }
    try{
        await loFirebasePushEvent('TEAM_ELIMINATED', {team:testTeam});
        loToast('🔔 وصل فايربيس فعلاً — تأكد أن نافذة/جهاز الأوفرلي مفتوح ومحدَّث لآخر نسخة لرؤيته','info');
    }catch(e){
        loToast('❌ فشل الإرسال لفايربيس (صلاحيات/اتصال) — هذا سبب عدم وصوله للجهاز الثاني: '+(e?.code||e?.message||e),'warn');
    }
}

/* ════ إعدادات عرض الفرق المتبقية الدوّار (Spotlight) ════ */
function loSaveSpotlightCfg(){ try{ localStorage.setItem('lo_spotlight_cfg',JSON.stringify(loSpotlightCfg)); }catch(_){} }
function loSetSpotlightEnabled(v){ loSpotlightCfg.enabled=v; loSaveSpotlightCfg(); loBroadcast(); }
function loSetSpotlightN(field,v){
    const n=parseInt(v)||0;
    loSpotlightCfg[field]=Math.max(1,n);
    loSaveSpotlightCfg();
    loBroadcast();
}
function loSyncSpotlightUI(){
    const en=document.getElementById('loSpotEnabled'); if(en) en.checked=loSpotlightCfg.enabled!==false;
    const tc=document.getElementById('loSpotTrigger'); if(tc) tc.value=loSpotlightCfg.triggerCount;
    const cy=document.getElementById('loSpotCycles'); if(cy) cy.value=loSpotlightCfg.cycles;
}

/* ════ خلفية إقصاء خاصة بكل فريق (تُستخدم بدل الخلفية العامة عند إقصاء هذا الفريق تحديداً) ════ */
function loOpenTeamElimBg(tid){
    const t=loTeams.find(t=>t.id===tid); if(!t) return;
    document.getElementById('lo-tebg-popup')?.remove();
    const cur=loTeamElimBg[tid];
    const pop=document.createElement('div');
    pop.id='lo-tebg-popup';
    pop.className='lo-place-popup';
    pop.style.minWidth='250px';
    pop.innerHTML=`<h4>🎬 خلفية إقصاء خاصة — ${t.name}</h4>
        <div style="color:#8899aa;font-size:.72rem;margin-bottom:.7rem;line-height:1.5">إذا رفعت صورة أو فيديو هنا، تُستخدم فقط لحظة إقصاء "${t.name}"، بدل الخلفية العامة</div>
        <div class="lo-bg-zone ${cur?'has-bg':''}" id="loTebgZone" onclick="document.getElementById('loTebgInp').click()">
            ${cur?`<button class="lo-bg-clear" onclick="event.stopPropagation();loClearTeamElimBg(${tid})">✕</button>`:''}
            <i class="fas fa-film" style="color:#00e5ff;font-size:1.3rem"></i>
            <div id="loTebgPreview">${cur?(cur.type==='video'?`<video src="${cur.data}" muted autoplay loop></video>`:`<img src="${cur.data}">`):''}</div>
            <div style="color:#667788;font-size:.72rem;margin-top:.2rem">اضغط لرفع صورة/فيديو</div>
        </div>
        <input type="file" id="loTebgInp" accept="image/*,video/*" style="display:none" onchange="loSetTeamElimBg(${tid},this)">
        <button class="lo-pl-cancel" style="background:rgba(68,238,85,.12);border-color:rgba(68,238,85,.25);color:#44ee55;margin-top:.6rem" onclick="document.getElementById('lo-tebg-popup')?.remove()">✅ تم</button>`;
    document.body.appendChild(pop);
}
function loSetTeamElimBg(tid,inp){
    const file=inp?.files?.[0]; if(!file) return;
    const isVideo=file.type.startsWith('video');
    if(!file.type.startsWith('image')&&!isVideo){ loToast('⚠️ اختر صورة أو فيديو فقط','warn'); return; }
    if(file.size>40*1024*1024){ loToast('⚠️ الملف كبير جداً (أقصى 40MB)','warn'); return; }

    /* معاينة فورية محلية */
    loTeamElimBg[tid]={type:isVideo?'video':'image',data:URL.createObjectURL(file)};
    loRenderTable();
    loOpenTeamElimBg(tid);
    loToast('⏳ جاري رفع خلفية الفريق...','info');

    loUploadBgToStorage(file,`bg/elimBg_team_${tid}_${Date.now()}_${file.name}`).then(async url=>{
        const bgObj={type:isVideo?'video':'image',data:url};
        loTeamElimBg[tid]=bgObj;
        try{ await loIdbSet('elimBg_team_'+tid,bgObj); }catch(_){}
        loRenderTable();
        loBroadcast();
        loOpenTeamElimBg(tid);
        loToast('✅ تم حفظ ومزامنة خلفية الفريق','ok');
    }).catch(err=>{
        console.error('[loSetTeamElimBg] فشل الرفع:',err);
        loToast('⚠️ تعذر الرفع للإنترنت — الخلفية راح تشتغل بجهازك بس ('+err.message+')','warn');
        const r=new FileReader();
        r.onload=async e=>{
            try{
                const bgObj={type:isVideo?'video':'image',data:e.target.result};
                loTeamElimBg[tid]=bgObj;
                await loIdbSet('elimBg_team_'+tid,bgObj);
                loRenderTable();
                loBroadcast();
                loOpenTeamElimBg(tid);
            }catch(err2){ console.error('[loSetTeamElimBg] fallback error:',err2); }
        };
        r.readAsDataURL(file);
    });
}
async function loClearTeamElimBg(tid){
    delete loTeamElimBg[tid];
    try{ await loIdbDelete('elimBg_team_'+tid); }catch(e){ console.warn('[loClearTeamElimBg]',e); }
    loRenderTable();
    loBroadcast();
    document.getElementById('lo-tebg-popup')?.remove();
}
function loExportJSON(){ const blob=new Blob([JSON.stringify({teams:loTeams,elimOrder:loEliminationOrder,updated:new Date().toISOString()},null,2)],{type:'application/json'}); const u=URL.createObjectURL(blob),a=document.createElement('a'); a.href=u; a.download=`pubg-round-${Date.now()}.json`; a.click(); URL.revokeObjectURL(u); }
function loDefaultTeams(){
    return [['Team Alpha','ALP','🇮🇶','#ff4444'],['Team Beta','BET','🇸🇦','#44aaff'],['Team Gamma','GMM','🇦🇪','#44ff88'],['Team Delta','DLT','🇰🇼','#ffaa00'],['Team Echo','ECH','🇶🇦','#aa44ff'],['Team Foxtrot','FOX','🇧🇭','#ff44aa']]
        .map((t,i)=>({id:i+1,name:t[0],abbr:t[1],flag:t[2],color:t[3],logo:null,players:Array.from({length:4},()=>({name:'',status:'alive'})),kills:0,placementPts:0,place:null}));
}

/* ════ Placement popup ════ */
function loOpenPlace(tid,rank){
    document.getElementById('lo-place-popup-el')?.remove();
    const pop=document.createElement('div'); pop.id='lo-place-popup-el'; pop.className='lo-place-popup';
    const opts=Array.from({length:16},(_,i)=>i+1).map(p=>`<button class="lo-pl-opt" onclick="loSetP(${tid},${p},${LO_PLACEMENT[p]||0})">#${p}<br><small style="color:#ffd70088">+${LO_PLACEMENT[p]||0}</small></button>`).join('');
    pop.innerHTML=`<h4>📍 مكان الفريق</h4><div class="lo-pl-grid">${opts}</div><button class="lo-pl-cancel" onclick="document.getElementById('lo-place-popup-el')?.remove()">إلغاء</button>`;
    document.body.appendChild(pop);
    setTimeout(()=>document.addEventListener('click',function h(e){ if(!pop.contains(e.target)){pop.remove();document.removeEventListener('click',h);} }),100);
}
function loSetP(tid,place,pts){ const t=loTeams.find(t=>t.id===tid); if(t){t.place=place;t.placementPts=pts;} document.getElementById('lo-place-popup-el')?.remove(); loRenderTable(); loBroadcast(); }

/* ════ Distribute ════ */
function loShowDist(){
    document.getElementById('lo-dist-popup-el')?.remove();
    const sorted=loSorted(), elim=[...loEliminationOrder].reverse(), alive=loTeams.filter(t=>!loEliminationOrder.includes(t.id)).sort((a,b)=>loTotal(b)-loTotal(a));
    let place=1; const preview=[];
    alive.forEach(t=>{ preview.push({id:t.id,name:t.name,place,pts:LO_PLACEMENT[place]||0,how:'حي'}); place++; });
    elim.forEach(tid=>{ const t=loTeams.find(t=>t.id===tid); if(!t) return; preview.push({id:t.id,name:t.name,place,pts:LO_PLACEMENT[place]||0,how:`مات #${loEliminationOrder.indexOf(tid)+1}`}); place++; });
    const pop=document.createElement('div'); pop.id='lo-dist-popup-el'; pop.className='lo-dist-popup';
    pop.innerHTML=`<h4>🏁 توزيع نقاط المراكز</h4><p>الفرق الحية → أفضل مراكز | الميتون بالترتيب → الأسوأ</p>
    <div class="lo-dist-list">${preview.map(p=>`<div class="lo-di"><span class="r">${p.place<=3?['🥇','🥈','🥉'][p.place-1]:'#'+p.place}</span><span class="n">${p.name}</span><span style="color:#667;font-size:.7rem">${p.how}</span><span class="p">+${p.pts}</span></div>`).join('')}</div>
    <div class="lo-dist-row"><button class="lo-dist-ok" onclick="loConfDist()">✅ تأكيد</button><button class="lo-dist-cancel" onclick="document.getElementById('lo-dist-popup-el')?.remove()">إلغاء</button></div>`;
    document.body.appendChild(pop);
    window._loDistPreview=preview;
}
function loConfDist(){
    document.getElementById('lo-dist-popup-el')?.remove();
    (window._loDistPreview||[]).forEach(d=>{ const t=loTeams.find(t=>t.id===d.id); if(t){t.place=d.place;t.placementPts=d.pts;} });
    loRenderTable(); loBroadcast();
    loToast('🏁 تم توزيع نقاط المراكز!','ok');
}

/* ════════════════════════════════════════════════
   خلفيات الأوفرلي (صورة/فيديو)
════════════════════════════════════════════════ */
function loSetBg(key,inp){
    try{
        const file=inp?.files?.[0];
        if(!file){ console.warn('[loSetBg] لم يتم اختيار ملف'); return; }
        const isVideo=file.type.startsWith('video');
        if(!file.type.startsWith('image')&&!isVideo){
            loToast('⚠️ اختر صورة أو فيديو فقط','warn');
            return;
        }
        if(file.size>40*1024*1024){
            loToast('⚠️ الملف كبير جداً (أقصى 40MB) — الحجم الحالي: '+(file.size/1024/1024).toFixed(1)+'MB','warn');
            return;
        }

        /* معاينة فورية بجهازك (بلاك محلي، بدون انتظار الرفع) */
        loBgSettings[key]={type:isVideo?'video':'image',data:URL.createObjectURL(file)};
        loSyncBgUI();
        loToast('⏳ جاري رفع الخلفية حتى توصل لأي جهاز ثاني...','info');

        /* الرفع الفعلي لفايربيس ستوريج — الرابط الراجع خفيف وينبعث عبر Realtime Database */
        loUploadBgToStorage(file,`bg/${key}_${Date.now()}_${file.name}`).then(async url=>{
            const bgObj={type:isVideo?'video':'image',data:url};
            loBgSettings[key]=bgObj;
            try{ await loIdbSet(key,bgObj); }catch(_){}
            loSyncBgUI();
            loBroadcast();
            loToast('✅ الخلفية مرفوعة ومتزامنة على كل الأجهزة','ok');
        }).catch(err=>{
            console.error('[loSetBg] فشل الرفع لفايربيس ستوريج:',err);
            loToast('⚠️ تعذر الرفع للإنترنت — الخلفية راح تشتغل بجهازك بس مو بجهاز ثاني ('+err.message+')','warn');
            /* تراجع للسلوك القديم (تخزين محلي base64) حتى تضل شغالة بجهازك على الأقل */
            const r=new FileReader();
            r.onload=async e=>{
                try{
                    const bgObj={type:isVideo?'video':'image',data:e.target.result};
                    loBgSettings[key]=bgObj;
                    await loIdbSet(key,bgObj);
                    loSyncBgUI();
                    loBroadcast();
                }catch(err2){ console.error('[loSetBg] fallback error:',err2); }
            };
            r.readAsDataURL(file);
        });
    }catch(err){
        console.error('[loSetBg] outer error:',err);
        loToast('❌ خطأ غير متوقع: '+err.message,'warn');
    }
}
async function loClearBg(key){
    loBgSettings[key]=null;
    try{ await loIdbDelete(key); }catch(e){ console.warn('[loClearBg] تعذر الحذف من IndexedDB:',e); }
    loSyncBgUI();
    loBroadcast();
}
function loSyncBgUI(){
    [['headerBg','loHeaderBgZone','loHeaderBgPreview'],['bodyBg','loBodyBgZone','loBodyBgPreview'],['elimBannerBg','loEbBgZone','loEbBgPreview'],['killCardBg','loKcBgZone','loKcBgPreview']].forEach(([key,zoneId,prevId])=>{
        const zone=document.getElementById(zoneId), prev=document.getElementById(prevId);
        if(!zone||!prev) return;
        const bg=loBgSettings[key];
        if(bg){
            zone.classList.add('has-bg');
            prev.innerHTML = bg.type==='video'
                ? `<video src="${bg.data}" muted autoplay loop></video>`
                : `<img src="${bg.data}">`;
        } else {
            zone.classList.remove('has-bg');
            prev.innerHTML='';
        }
    });
}

/* ════════════════════════════════════════════════
   كاميرا المسح — التقاط منطقة + رصد قتل بالذكاء الاصطناعي
════════════════════════════════════════════════ */
async function loStartScanSetup(){
    try{
        loScanStream=await navigator.mediaDevices.getDisplayMedia({video:{cursor:'never'},audio:false});
    }catch(e){ loToast('⚠️ لازم تسمح بمشاركة الشاشة','warn'); return; }

    document.getElementById('loScanSetup').style.display='none';
    document.getElementById('loScanPicker').style.display='block';

    const video=document.getElementById('loScanVideo');
    video.srcObject=loScanStream;
    await new Promise(r=>video.addEventListener('loadedmetadata',r,{once:true}));

    /* Stop setup if user cancels the browser share dialog */
    loScanStream.getVideoTracks()[0].addEventListener('ended',loCancelScanSetup);

    loEnableRectDrag();
}

function loEnableRectDrag(){
    const rect=document.getElementById('loScanRect');
    const wrap=document.getElementById('loScanVideoWrap');
    const handle=document.getElementById('loScanHandle');
    let dragging=false, resizing=false, startX=0, startY=0, origLeft=0, origTop=0, origW=0, origH=0;

    rect.onpointerdown=e=>{
        if(e.target===handle) return;
        dragging=true; startX=e.clientX; startY=e.clientY;
        origLeft=rect.offsetLeft; origTop=rect.offsetTop;
        e.preventDefault();
    };
    handle.onpointerdown=e=>{
        resizing=true; startX=e.clientX; startY=e.clientY;
        origW=rect.offsetWidth; origH=rect.offsetHeight;
        e.stopPropagation(); e.preventDefault();
    };
    document.addEventListener('pointermove',e=>{
        if(dragging){
            const dx=e.clientX-startX, dy=e.clientY-startY;
            const maxL=wrap.offsetWidth-rect.offsetWidth, maxT=wrap.offsetHeight-rect.offsetHeight;
            rect.style.left=Math.max(0,Math.min(maxL,origLeft+dx))+'px';
            rect.style.top=Math.max(0,Math.min(maxT,origTop+dy))+'px';
        }
        if(resizing){
            const dx=e.clientX-startX, dy=e.clientY-startY;
            rect.style.width=Math.max(60,origW+dx)+'px';
            rect.style.height=Math.max(30,origH+dy)+'px';
        }
    });
    document.addEventListener('pointerup',()=>{ dragging=false; resizing=false; });
}

function loCancelScanSetup(){
    loScanStream?.getTracks()?.forEach(t=>t.stop());
    loScanStream=null;
    document.getElementById('loScanSetup').style.display='block';
    document.getElementById('loScanPicker').style.display='none';
    document.getElementById('loScanActive').style.display='none';
}

function loConfirmScanRegion(){
    const video=document.getElementById('loScanVideo');
    const rect=document.getElementById('loScanRect');
    const wrap=document.getElementById('loScanVideoWrap');
    const scaleX=video.videoWidth/wrap.offsetWidth;
    const scaleY=video.videoHeight/wrap.offsetHeight;
    loScanRegion={
        x:rect.offsetLeft*scaleX, y:rect.offsetTop*scaleY,
        w:rect.offsetWidth*scaleX, h:rect.offsetHeight*scaleY,
    };
    document.getElementById('loScanPicker').style.display='none';
    document.getElementById('loScanActive').style.display='block';
    loScanActive=true;
    loScanLoop();
    loToast('✅ بدأت مراقبة الكيل فيد','ok');
}

function loStopScan(){
    loScanActive=false;
    clearTimeout(loScanTimer);
    loScanStream?.getTracks()?.forEach(t=>t.stop());
    loScanStream=null;
    loLastSpectateKey=null;
    if(window._loGrabVideo){ window._loGrabVideo.srcObject=null; }
    document.getElementById('loScanSetup').style.display='block';
    document.getElementById('loScanActive').style.display='none';
    document.getElementById('loScanPicker').style.display='none';
}

async function loScanLoop(){
    if(!loScanActive||!loScanStream) return;
    try{
        /* فيديو مخفي دائم لالتقاط الإطارات — أضمن من ImageCapture API */
        if(!window._loGrabVideo){
            window._loGrabVideo=document.createElement('video');
            window._loGrabVideo.muted=true; window._loGrabVideo.playsInline=true;
            window._loGrabVideo.style.display='none';
            document.body.appendChild(window._loGrabVideo);
        }
        const gv=window._loGrabVideo;
        if(gv.srcObject!==loScanStream){
            gv.srcObject=loScanStream;
            await gv.play().catch(()=>{});
            await new Promise(r=>{ if(gv.readyState>=2) r(); else gv.addEventListener('loadeddata',r,{once:true}); });
        }

        const cv=document.createElement('canvas');
        cv.width=loScanRegion.w; cv.height=loScanRegion.h;
        const ctx=cv.getContext('2d');
        ctx.drawImage(gv,loScanRegion.x,loScanRegion.y,loScanRegion.w,loScanRegion.h,0,0,loScanRegion.w,loScanRegion.h);

        const thumb=document.getElementById('loScanThumbWrap');
        if(thumb) thumb.innerHTML=`<img src="${cv.toDataURL('image/jpeg',.7)}" style="width:100%;display:block">`;

        await (loScanMode==='board' ? loDetectBoardState(cv) : loScanMode==='spectate' ? loDetectSpectateCard(cv) : loDetectKillEvent(cv));
    }catch(e){ loLog('⚠️ خطأ بالمسح: '+e.message); }
    loScanTimer=setTimeout(loScanLoop,loScanIntervalMs);
}

function loSetScanMode(mode){
    loScanMode=mode;
    document.querySelectorAll('.lo-scan-mode-btn').forEach(b=>b.classList.toggle('active', b.dataset.mode===mode));
    const hint=document.getElementById('loScanModeHint');
    const pickerHint=document.getElementById('loScanPickerHint');
    const undoBtn=document.getElementById('loUndoBoardBtn');
    if(mode==='board'){
        if(hint) hint.textContent='يقرأ لوحة كل الفرق كاملة كل مسحة (اسم/رقم الفريق، كلاته، وحي/ميت كل لاعب)، ويزامن الجدول بالكامل مع الي طالع بالصورة — تلقائي التصحيح، ما يحتاج تتبّع أحداث.';
        if(pickerHint) pickerHint.textContent='اسحب المربع فوق لوحة/شاشة كل الفرق (اللي تبين كل فريق مع عدد كلاته وحالة لاعبيه)';
        if(undoBtn) undoBtn.style.display='';
    } else if(mode==='spectate'){
        if(hint) hint.textContent='يقرأ كارد وضع المشاهدة (اسم الفريق، اللاعب، الضرر، أطول مسافة إقصاء، الإسقاطات) ويحدّث "كارد القتلة" وحده أول ما يتغيّر اللاعب المعروض — بدون ما تدخل شي يدوي.';
        if(pickerHint) pickerHint.textContent='اسحب المربع فوق كارد الإحصائيات اللي يطلع بوضع المشاهدة (اسم الفريق، الضرر، المسافة، الإسقاطات)';
        if(undoBtn) undoBtn.style.display='none';
    } else {
        if(hint) hint.textContent='يراقب سطر "فلان قتل فلان" بالكيل فيد ويحدّث حالة اللاعب المحدد فقط (نوك/تفنيش) لحظة حدوثه.';
        if(pickerHint) pickerHint.textContent='اسحب المربع وحجّمه فوق منطقة أسماء اللاعبين بالكيل فيد';
        if(undoBtn) undoBtn.style.display='none';
    }
}

function loSetOcrAutoApply(v){
    loOcrAutoApply=v;
    try{ localStorage.setItem('lo_ocr_auto_apply',JSON.stringify(v)); }catch(_){}
    /* بتغيير الوضع، نفرّغ أي طابور تأكيد يدوي معلّق حتى ما يختلط الوضعين */
    if(v){ loPendingKillQueue=[]; document.getElementById('lo-pending-kill-el')?.remove(); loPendingKillShowing=false; }
}
function loSetScanInterval(v){
    loScanIntervalMs=parseInt(v)||3000;
    try{ localStorage.setItem('lo_scan_interval',String(loScanIntervalMs)); }catch(_){}
    const txt=document.getElementById('loScanStatusTxt');
    if(txt) txt.textContent='المراقبة تعمل — كل '+(loScanIntervalMs/1000)+' ثواني';
}

function loLog(msg){
    const el=document.getElementById('loScanLog'); if(!el) return;
    const line=document.createElement('div');
    line.textContent=`[${new Date().toLocaleTimeString('ar')}] ${msg}`;
    el.prepend(line);
    while(el.children.length>25) el.removeChild(el.lastChild);
}

/* يرسل القصاصة لـ Claude ليكتشف كل أحداث القتل الظاهرة (قد يكون أكثر من حدث بنفس اللقطة) */
async function loDetectKillEvent(canvas){
    const allNames=[];
    loTeams.forEach(t=>t.players.forEach((p,pi)=>{ if(p.name) allNames.push({team:t.id,pi,name:p.name}); }));
    if(allNames.length<2){ loLog('⚠️ أضف أسماء اللاعبين أولاً ليعمل الرصد'); loScanActive=false; return; }

    const b64=canvas.toDataURL('image/jpeg',.8).split(',')[1];
    try{
        const resp=await fetch('https://api.anthropic.com/v1/messages',{
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({
                model:'claude-sonnet-4-20250514',
                max_tokens:400,
                messages:[{role:'user',content:[
                    {type:'image',source:{type:'base64',media_type:'image/jpeg',data:b64}},
                    {type:'text',text:`هذه قصاصة من كيل فيد (kill feed) بلعبة باتل رويال. أسماء اللاعبين المعروفة: ${allNames.map(n=>n.name).join(', ')}.
اكتشف كل أحداث "قتل" الظاهرة بالصورة بين اسمين من هذي القائمة (ممكن يكون أكثر من حدث بنفس اللقطة إذا صار أكثر من إقصاء بنفس اللحظة). أعد JSON فقط بهذا الشكل:
{"events":[{"killer":"اسم القاتل","victim":"اسم الضحية"}]}
إذا ما فيه أي حدث واضح، أعد {"events":[]}. لا تكتب أي نص إضافي غير الـ JSON.`}
                ]}]
            })
        });
        const data=await resp.json();
        const txt=data.content?.[0]?.text||'{"events":[]}';
        let parsed={events:[]};
        try{ parsed=JSON.parse(txt.replace(/```json?|```/g,'').trim()); }catch(_){}

        const events=Array.isArray(parsed.events)?parsed.events:(parsed.killer?[parsed]:[]);
        if(!events.length) return;

        for(const ev of events){
            if(!ev.killer||!ev.victim) continue;
            const killer=allNames.find(n=>n.name.toLowerCase()===String(ev.killer).toLowerCase());
            const victim=allNames.find(n=>n.name.toLowerCase()===String(ev.victim).toLowerCase());
            if(!killer||!victim||killer.team===victim.team) continue;

            const dedupKey=`${killer.name}|${victim.name}`.toLowerCase();
            if(loIsDuplicateEvent(dedupKey)) continue; /* نفس الحدث لسا ظاهر بالكيل فيد من مسحة سابقة — تجاهله */
            loMarkEventSeen(dedupKey);

            loLog(`🎯 رُصد: ${ev.killer} ⚔️ ${ev.victim}`);
            if(loOcrAutoApply){
                loApplyKillEvent(killer,victim);
            } else {
                loEnqueuePendingKill(killer,victim);
            }
        }
    }catch(e){ loLog('⚠️ تعذّر تحليل القصاصة'); }
}

/* منع تطبيق نفس الحدث أكثر من مرة لو ظل ظاهر بالكيل فيد لعدة مسحات متتالية */
function loIsDuplicateEvent(key){
    const now=Date.now();
    loSeenEvents=loSeenEvents.filter(e=>now-e.ts<15000);
    return loSeenEvents.some(e=>e.key===key);
}
function loMarkEventSeen(key){ loSeenEvents.push({key,ts:Date.now()}); }

let loLastSpectateKey=null; /* آخر لاعب تم رصده بكارد المشاهدة — نمنع تكرار نفس الكارد وهو لسا ظاهر */

/* ════ وضع "كارد المشاهدة" — يقرأ كارد إحصائيات وضع Spectate ويحدّث كارد القتلة تلقائياً ════ */
async function loDetectSpectateCard(canvas){
    if(loTeams.length<1){ loLog('⚠️ أضف الفرق أولاً ليعمل الرصد'); loScanActive=false; return; }

    const teamsInfo = loTeams.map(t=>`- "${t.name}" (${t.abbr||''})`).join('\n');
    const b64=canvas.toDataURL('image/jpeg',.8).split(',')[1];
    try{
        const resp=await fetch('https://api.anthropic.com/v1/messages',{
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({
                model:'claude-sonnet-4-20250514',
                max_tokens:300,
                messages:[{role:'user',content:[
                    {type:'image',source:{type:'base64',media_type:'image/jpeg',data:b64}},
                    {type:'text',text:`هذه قصاصة من كارد إحصائيات وضع "المشاهدة" (Spectate) بلعبة باتل رويال — يبين اسم الفريق، اسم اللاعب، الضرر (Damage Dealt)، أطول مسافة إقصاء (Longest Elim Distance)، وعدد الإسقاطات الملتقطة (Airdrop Looted).
الفرق المسجلة بالنظام: ${teamsInfo}

طابق اسم الفريق الظاهر بالصورة مع فريق من القائمة أعلاه إذا أمكن، واستخرج القيم الظاهرة. أعد JSON فقط بهذا الشكل:
{"team":"اسم الفريق كما بالقائمة أعلاه أو كما يظهر بالصورة إذا ما طابق شي","player":"اسم اللاعب","damage":177,"distance":203,"airdrops":0}
إذا أي قيمة مو واضحة بالصورة خليها null. إذا ماكو كارد واضح بالصورة أصلاً، أعد {"team":null}. لا تكتب أي نص إضافي غير الـ JSON.`}
                ]}]
            })
        });
        const data=await resp.json();
        const txt=data.content?.[0]?.text||'{"team":null}';
        let parsed={team:null};
        try{ parsed=JSON.parse(txt.replace(/```json?|```/g,'').trim()); }catch(_){}
        if(!parsed.team) return;

        /* منع تكرار نفس الكارد وهو لسا ظاهر بالشاشة (يبقى العنوان نفسه لعدة ثواني عادة) */
        const key=`${parsed.team}|${parsed.player||''}`.toLowerCase();
        if(key===loLastSpectateKey) return;
        loLastSpectateKey=key;

        const matched=loTeams.find(t=>
            t.name.toLowerCase()===String(parsed.team).toLowerCase() ||
            (t.abbr&&t.abbr.toLowerCase()===String(parsed.team).toLowerCase())
        );
        /* إذا ما طابقنا فريق مسجّل، نسوي كارد مؤقت بنفس الاسم الظاهر بالصورة بدون شعار/لون */
        const teamForCard = matched || {id:-1,name:parsed.team,abbr:'',logo:null,flag:'none',color:'#888'};

        loLog(`📊 رُصد كارد مشاهدة: ${parsed.team}${parsed.player?' — '+parsed.player:''}`);
        loAnnounceKillCard(teamForCard, parsed.player||'', parsed.damage??null, parsed.distance??null, parsed.airdrops??null);
    }catch(e){ loLog('⚠️ تعذّر تحليل كارد المشاهدة'); }
}


async function loDetectBoardState(canvas){
    if(loTeams.length<2){ loLog('⚠️ أضف الفرق أولاً ليعمل الرصد'); loScanActive=false; return; }

    const teamsInfo = loTeams.map(t=>
        `- "${t.name}" (${t.abbr||''}): لاعبين بالترتيب: ${t.players.map(p=>p.name||'؟').join(', ')}`
    ).join('\n');

    const b64=canvas.toDataURL('image/jpeg',.8).split(',')[1];
    try{
        const resp=await fetch('https://api.anthropic.com/v1/messages',{
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({
                model:'claude-sonnet-4-20250514',
                max_tokens:900,
                messages:[{role:'user',content:[
                    {type:'image',source:{type:'base64',media_type:'image/jpeg',data:b64}},
                    {type:'text',text:`هذه صورة من شاشة تعرض كل الفرق بلعبة باتل رويال (قائمة فرق فيها اسم/رقم الفريق، عدد الكلات، وحالة كل لاعب حي/ميت).
الفرق المسجلة بالنظام حالياً مع أسماء لاعبيها بالترتيب:
${teamsInfo}

طابق كل فريق ظاهر بالصورة مع فريق من القائمة أعلاه (حسب الاسم أو الرقم)، واستخرج له:
- kills: عدد الكلات الكلي الظاهر للفريق
- alive: مصفوفة بطول 4 (بترتيب اللاعبين أعلاه) — true للاعب الحي، false للاعب الميت/المُقصى. إذا الصورة ما تفرّق بين اللاعبين بالاسم وبس تبين عدد أيقونات حية، رتبهم بنفس ترتيب القائمة قد ما تقدر.

أعد JSON فقط بهذا الشكل، وبس للفرق الي قدرت تحدد بياناتها بوضوح:
{"teams":[{"team":"الاسم كما بالقائمة أعلاه بالضبط","kills":N,"alive":[true,true,false,true]}]}
لا تكتب أي نص إضافي غير الـ JSON.`}
                ]}]
            })
        });
        const data=await resp.json();
        const txt=data.content?.[0]?.text||'{"teams":[]}';
        let parsed={teams:[]};
        try{ parsed=JSON.parse(txt.replace(/```json?|```/g,'').trim()); }catch(_){}
        if(Array.isArray(parsed.teams)&&parsed.teams.length) loApplyBoardState(parsed.teams);
    }catch(e){ loLog('⚠️ تعذّر تحليل لوحة الفرق'); }
}

/* يزامن حالة الفرق بالكامل حسب الي انقرا من اللوحة — يحفظ نسخة قبل التغيير عشان زر التراجع */
function loApplyBoardState(detected){
    loLastBoardSnapshot = {
        teams: JSON.parse(JSON.stringify(loTeams.map(t=>({id:t.id,kills:t.kills,players:t.players.map(p=>p.status)})))),
        elimOrder: [...loEliminationOrder],
    };

    let changedCount=0;
    for(const d of detected){
        if(!d.team) continue;
        const t=loTeams.find(t=> t.name.toLowerCase()===String(d.team).toLowerCase() || (t.abbr&&t.abbr.toLowerCase()===String(d.team).toLowerCase()) );
        if(!t) continue;
        let changed=false;

        if(typeof d.kills==='number' && d.kills>=0 && d.kills!==t.kills){
            t.kills=d.kills;
            changed=true;
        }
        if(Array.isArray(d.alive)){
            d.alive.forEach((isAlive,pi)=>{
                if(!t.players[pi]) return;
                const wantStatus = isAlive ? 'alive' : 'eliminated';
                /* لا نلمس حالة "نوك" الحالية إذا اللوحة تقول حي (نوك يعتبر لسا بالحياة بالمعنى الفريقي) */
                if(!isAlive && t.players[pi].status!=='eliminated'){ t.players[pi].status='eliminated'; changed=true; }
                else if(isAlive && t.players[pi].status==='eliminated'){ t.players[pi].status='alive'; changed=true; } /* تصحيح لو انغلط سابقاً */
            });
        }

        if(changed){
            changedCount++;
            const allDead=loAllDead(t);
            if(allDead&&!loEliminationOrder.includes(t.id)){
                loEliminationOrder.push(t.id);
                loAutoPlaceOnElim(t);
                loAnnounceElimination(t);
            } else if(!allDead){
                const idx=loEliminationOrder.indexOf(t.id);
                if(idx>-1) loEliminationOrder.splice(idx,1); /* رجع حي بعد ما كان مسجل مقصى (تصحيح) */
            }
        }
    }

    if(changedCount>0){
        loLog(`🔄 مزامنة اللوحة: تحديث ${changedCount} فريق`);
        loRenderTable(); loBroadcast();
    }
}

/* يرجّع آخر مزامنة شاملة (وضع لوحة الفرق فقط) */
function loUndoBoardSync(){
    if(!loLastBoardSnapshot){ loToast('⚠️ ماكو مزامنة سابقة نرجعلها','warn'); return; }
    loLastBoardSnapshot.teams.forEach(snap=>{
        const t=loTeams.find(t=>t.id===snap.id); if(!t) return;
        t.kills=snap.kills;
        snap.players.forEach((st,pi)=>{ if(t.players[pi]) t.players[pi].status=st; });
    });
    loEliminationOrder=loLastBoardSnapshot.elimOrder;
    loLastBoardSnapshot=null;
    loRenderTable(); loBroadcast();
    loToast('↩️ تم التراجع عن آخر مزامنة','info');
}

/* تطبيق فوري بدون تأكيد — للوضع التلقائي. يدعم "تراجع" لو صار خطأ بالرصد */
function loApplyKillEvent(killer,victim){
    const vTeam=loTeams.find(t=>t.id===victim.team);
    const kTeam=loTeams.find(t=>t.id===killer.team);
    if(!vTeam||!kTeam) return;
    const vPlayer=vTeam.players[victim.pi];
    if(vPlayer.status==='eliminated') return; /* ميت أصلاً — لا شي نسويه */

    const prevStatus=vPlayer.status;
    const wasAlreadyElim=loEliminationOrder.includes(vTeam.id);
    let killPointApplied=false;

    if(vPlayer.status==='knocked'){
        vPlayer.status='eliminated';
        loKDirect(kTeam.id,1);
        killPointApplied=true;
        loAnnounceKillCard(vTeam,victim.name,null,null,null,kTeam,'kill',1);
        loActionToast(`☠️ تفنيش تلقائي: ${killer.name} ⚔️ ${victim.name} (+1 لـ${kTeam.abbr})`,
            ()=>loUndoKillEvent(vTeam.id,victim.pi,prevStatus,kTeam.id,killPointApplied,wasAlreadyElim));
    } else {
        vPlayer.status='knocked';
        loAnnounceKillCard(vTeam,victim.name,null,null,null,kTeam,'knock',1);
        loActionToast(`🎯 نوك تلقائي: ${killer.name} ⚔️ ${victim.name}`,
            ()=>loUndoKillEvent(vTeam.id,victim.pi,prevStatus,kTeam.id,killPointApplied,wasAlreadyElim));
    }

    const allDead=loAllDead(vTeam);
    if(allDead&&!loEliminationOrder.includes(vTeam.id)){
        loEliminationOrder.push(vTeam.id);
        loAutoPlaceOnElim(vTeam);
        loAnnounceElimination(vTeam);
    }
    loRenderTable(); loBroadcast();
}
function loUndoKillEvent(vTid,vPi,prevStatus,kTid,killPointApplied,wasAlreadyElim){
    const vTeam=loTeams.find(t=>t.id===vTid);
    const kTeam=loTeams.find(t=>t.id===kTid);
    if(!vTeam) return;
    if(vTeam.players[vPi]) vTeam.players[vPi].status=prevStatus;
    if(killPointApplied&&kTeam) loKDirect(kTeam.id,-1);
    if(!wasAlreadyElim){
        const idx=loEliminationOrder.indexOf(vTid);
        if(idx>-1) loEliminationOrder.splice(idx,1);
    }
    loRenderTable(); loBroadcast();
    loToast('↩️ تم التراجع','info');
}
/* إضافة/خصم كيلز مباشرة بدون قفل منع التكرار (القفل مصمم لمنع دبل-كليك يدوي، مو مناسب لأحداث OCR المتعددة بنفس اللحظة) */
function loKDirect(tid,d){
    const t=loTeams.find(t=>t.id===tid); if(!t) return;
    t.kills=Math.max(0,(t.kills||0)+d);
}

/* ════ وضع التأكيد اليدوي (طابور) — لمن يفضّل مراجعة كل حدث قبل تطبيقه ════ */
function loEnqueuePendingKill(killer,victim){
    loPendingKillQueue.push({killer,victim});
    loProcessPendingQueue();
}
function loProcessPendingQueue(){
    if(loPendingKillShowing) return;
    const next=loPendingKillQueue.shift();
    if(!next) return;
    loPendingKillShowing=true;
    loShowPendingKill(next.killer,next.victim);
}

/* نافذة تأكيد حدث القتل — بضغطة وحدة، تدعم طابور لعدة أحداث متزامنة */
function loShowPendingKill(killer,victim){
    document.getElementById('lo-pending-kill-el')?.remove();
    const kTeam=loTeams.find(t=>t.id===killer.team);
    const vTeam=loTeams.find(t=>t.id===victim.team);
    const vPlayer=vTeam.players[victim.pi];
    const isFinish=vPlayer.status==='knocked'; /* إذا كان منوّك مسبقاً = هذا تفنيش */
    const myToken=++loPendingKillToken;

    const pop=document.createElement('div');
    pop.id='lo-pending-kill-el';
    pop.className='lo-pending-kill';
    pop.style.position='relative';
    const queueBadge=loPendingKillQueue.length>0
        ? `<div style="position:absolute;top:-10px;left:-10px;background:#ffd700;color:#000;font-size:.7rem;font-weight:900;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center">+${loPendingKillQueue.length}</div>`
        : '';
    pop.innerHTML=`
        ${queueBadge}
        <h4>${isFinish?'💀 رصد تفنيش':'🎯 رصد نوك'}</h4>
        <p style="color:#ccc;font-size:.82rem;margin-bottom:.7rem">
            <b style="color:${kTeam.color}">${killer.name}</b> (${kTeam.abbr}) ⚔️
            <b style="color:${vTeam.color}">${victim.name}</b> (${vTeam.abbr})
        </p>
        <div class="lo-pk-row">
            <button style="background:linear-gradient(135deg,#44ee55,#22aa33);color:#000" onclick="loConfirmPendingKill(${killer.team},${killer.pi},${victim.team},${victim.pi})">✅ تأكيد</button>
            <button style="background:rgba(255,68,68,.15);color:#f44" onclick="loDismissPendingKill()">✕ تجاهل</button>
        </div>`;
    document.body.appendChild(pop);
    /* إزالة تلقائية بعد 10 ثواني لو ما تفاعل، وتنتقل للحدث التالي بالطابور */
    setTimeout(()=>{ if(loPendingKillToken===myToken) loDismissPendingKill(); },10000);
}
function loDismissPendingKill(){
    document.getElementById('lo-pending-kill-el')?.remove();
    loPendingKillShowing=false;
    loProcessPendingQueue();
}

function loConfirmPendingKill(killerTid,killerPi,victimTid,victimPi){
    document.getElementById('lo-pending-kill-el')?.remove();
    const vTeam=loTeams.find(t=>t.id===victimTid);
    const kTeam=loTeams.find(t=>t.id===killerTid);
    if(!vTeam||!kTeam){ loPendingKillShowing=false; loProcessPendingQueue(); return; }
    const vPlayer=vTeam.players[victimPi];

    if(vPlayer.status==='knocked'){
        /* تفنيش — نضيف نقطة للقاتل */
        vPlayer.status='eliminated';
        loKDirect(killerTid,1);
        loAnnounceKillCard(vTeam,vPlayer.name,null,null,null,kTeam,'kill',1);
        loToast('☠️ تفنيش! +1 لفريق '+kTeam.abbr,'ok');
    } else {
        /* نوك أول */
        vPlayer.status='knocked';
        loAnnounceKillCard(vTeam,vPlayer.name,null,null,null,kTeam,'knock',1);
        loToast('🎯 تم تسجيل النوك','ok');
    }
    const allDead=loAllDead(vTeam);
    if(allDead&&!loEliminationOrder.includes(victimTid)){
        loEliminationOrder.push(victimTid);
        loAutoPlaceOnElim(vTeam);
        loAnnounceElimination(vTeam);
    }
    loRenderTable(); loBroadcast();
    loPendingKillShowing=false;
    loProcessPendingQueue();
}

/* ════ Toast ════ */
function loToast(msg,type){
    const c={ok:'#44ee55',warn:'#ffd700',error:'#ff4444',info:'#00e5ff'};
    const t=document.createElement('div');
    t.style.cssText=`position:fixed;bottom:22px;left:50%;transform:translateX(-50%) translateY(12px);background:linear-gradient(135deg,#0a1628,#0f1f3c);border:1.5px solid ${c[type]||'#00e5ff'};border-radius:50px;padding:9px 22px;z-index:99999;color:${c[type]||'#fff'};font-weight:700;font-size:.85rem;box-shadow:0 8px 24px rgba(0,0,0,.6);transition:all .3s;opacity:0`;
    t.textContent=msg;
    document.body.appendChild(t);
    requestAnimationFrame(()=>{ t.style.opacity='1'; t.style.transform='translateX(-50%) translateY(0)'; });
    setTimeout(()=>{ t.style.opacity='0'; setTimeout(()=>t.remove(),300); },2800);
}
/* توست مع زر "تراجع" — تُستخدم بعد تطبيق حدث تلقائي مباشرة (نوك/تفنيش) */
function loActionToast(msg,undoFn){
    const t=document.createElement('div');
    t.style.cssText=`position:fixed;bottom:22px;left:50%;transform:translateX(-50%) translateY(12px);background:linear-gradient(135deg,#0a1628,#0f1f3c);border:1.5px solid #44ee55;border-radius:50px;padding:8px 10px 8px 20px;z-index:99999;color:#fff;font-weight:700;font-size:.82rem;box-shadow:0 8px 24px rgba(0,0,0,.6);transition:all .3s;opacity:0;display:flex;align-items:center;gap:10px;max-width:90vw`;
    const span=document.createElement('span'); span.textContent=msg; span.style.whiteSpace='nowrap';
    t.appendChild(span);
    if(undoFn){
        const btn=document.createElement('button');
        btn.textContent='↩️ تراجع';
        btn.style.cssText='background:rgba(255,255,255,.14);border:none;border-radius:20px;color:#fff;padding:5px 13px;font-size:.76rem;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0';
        btn.onclick=()=>{ undoFn(); t.remove(); };
        t.appendChild(btn);
    }
    document.body.appendChild(t);
    requestAnimationFrame(()=>{ t.style.opacity='1'; t.style.transform='translateX(-50%) translateY(0)'; });
    setTimeout(()=>{ if(document.body.contains(t)){ t.style.opacity='0'; setTimeout(()=>t.remove(),300); } },6000);
}

console.log('%c🔴 Live Overlay v3 — OCR + PUBG API + Manual','color:#ff4444;font-weight:900;background:#030c1c;padding:4px 10px;border-radius:4px');
