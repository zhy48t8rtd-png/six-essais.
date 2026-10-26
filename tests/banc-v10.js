// Banc d'essai v10 : la vraie appli (index.html) sur plusieurs « appareils » simulés,
// face à un faux Supabase qui applique les mêmes règles que la vraie base.
const fs = require("fs"), { JSDOM } = require("jsdom"), { webcrypto } = require("crypto");
const HTML = fs.readFileSync(process.argv[2], "utf8");
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- Faux Supabase ---------- */
const srv = {
  users: {},          // email -> {id,email,pw,confirmed}
  tokens: {},         // token -> uid
  games: [],          // {id,user_id,word,...}
  notebook: [],       // {user_id,key,...}
  legacy: {},         // uid -> row
  failRefresh: false, // simule une session expirée
  dropAfterWrite: false, // simule une coupure réseau APRÈS que le serveur a enregistré
  log: [],
};
let n = 0;
const sess = u => { const at = "at" + (++n), rt = "rt" + n; srv.tokens[at] = u.id; srv.tokens[rt] = u.id; return { access_token: at, refresh_token: rt, expires_in: 3600, user: { id: u.id, email: u.email } } };
function addUser(email, confirmed = true) { const u = { id: webcrypto.randomUUID(), email, pw: "motdepasse", confirmed }; srv.users[email] = u; return u }
const res = (status, body) => ({ ok: status < 400, status, json: async () => body });
async function handle(url, opt) {
  const u = new URL(url), p = u.pathname, q = u.searchParams, body = opt.body ? JSON.parse(opt.body) : null;
  const auth = (opt.headers || {}).Authorization, uid = auth ? srv.tokens[auth.slice(7)] : null;
  srv.log.push(opt.method + " " + p);
  if (p == "/auth/v1/token") {
    if (q.get("grant_type") == "password") { const us = srv.users[body.email]; if (!us || us.pw != body.password) return res(400, { error_description: "Invalid login credentials" }); if (!us.confirmed) return res(400, { error_description: "Email not confirmed" }); return res(200, sess(us)) }
    if (srv.failRefresh) return res(400, { error_description: "Invalid Refresh Token" });
    const id = srv.tokens[body.refresh_token], us = Object.values(srv.users).find(x => x.id == id); return us ? res(200, sess(us)) : res(400, { error_description: "Invalid Refresh Token" });
  }
  if (p == "/auth/v1/signup") { if (srv.users[body.email]) return res(400, { msg: "User already registered" }); const us = addUser(body.email, false); return res(200, { id: us.id, email: us.email }) }
  if (p == "/auth/v1/logout") return res(204, null);
  if (!uid) return res(401, { message: "JWT expired" });
  if (p == "/rest/v1/games" && opt.method == "POST") {
    for (const r of body) { if ("user_id" in r) return res(403, { message: "permission denied for table games" }); if (!srv.games.some(g => g.id == r.id)) srv.games.push({ ...r, user_id: uid }) }
    if (srv.dropAfterWrite) { srv.dropAfterWrite = false; throw new TypeError("Load failed") }
    return res(201, null);
  }
  if (p == "/rest/v1/games") { const all = srv.games.filter(g => g.user_id == uid).sort((a, b) => a.played_at < b.played_at ? 1 : -1); const o = +q.get("offset") || 0, l = +q.get("limit") || 1000; return res(200, all.slice(o, o + l)) }
  if (p == "/rest/v1/rpc/notebook_write") { let k = 0; for (const e of body.p_entries) { const ex = srv.notebook.find(x => x.user_id == uid && x.key == e.key); if (!ex) { srv.notebook.push({ ...e, user_id: uid }); k++ } else if (ex.updated_at < e.updated_at) { Object.assign(ex, e); k++ } } return res(200, k) }
  if (p == "/rest/v1/notebook") return res(200, srv.notebook.filter(x => x.user_id == uid));
  if (p == "/rest/v1/legacy_stats") return res(200, srv.legacy[uid] ? [srv.legacy[uid]] : []);
  if (p == "/rest/v1/rpc/delete_my_account") { srv.games = srv.games.filter(g => g.user_id != uid); srv.notebook = srv.notebook.filter(g => g.user_id != uid); delete srv.legacy[uid]; for (const e in srv.users) if (srv.users[e].id == uid) delete srv.users[e]; return res(204, null) }
  if (p == "/rest/v1/user_data") {
    if (!process.env.V9) return res(403, { message: "permission denied for table user_data" });
    srv.ud = srv.ud || {};
    if (opt.method == "POST") { if (body.user_id != uid) return res(403, { message: "new row violates row-level security policy" }); srv.ud[uid] = body.data;
      // pour comparer, on reflète l'ancien paquet dans le registre
      srv.games = srv.games.filter(g => g.user_id != uid).concat((body.data.h || []).map(x => ({ id: x.d + x.w, user_id: uid, word: x.w, played_at: x.d, daily: !!x.dj })));
      return res(201, null) }
    return res(200, srv.ud[uid] ? [{ data: srv.ud[uid] }] : []);
  }
  return res(404, { message: "inconnu " + p });
}

/* ---------- Appareils ---------- */
class Device {
  constructor(name, preset) {
    this.name = name; this.online = true;
    const self = this;
    this.dom = new JSDOM(HTML, {
      url: "https://six-essais.fr/", runScripts: "dangerously", pretendToBeVisual: true,
      beforeParse(w) {
        if (preset) for (const [k, v] of Object.entries(preset)) w.localStorage.setItem(k, v);
        w.fetch = async (url, opt = {}) => { if (!self.online) throw new TypeError("Load failed"); return handle(url, opt) };
        Object.defineProperty(w, "crypto", { value: webcrypto });
        w.matchMedia = () => ({ matches: true, addListener() { }, addEventListener() { } }); // « réduire les animations » : pas d'ouverture animée
        w.confirm = () => true; w.alert = () => { }; w.prompt = () => null;
        w.HTMLCanvasElement.prototype.getContext = () => null;
      }
    });
    this.w = this.dom.window;
  }
  ev(code) { return this.w.eval(code) }
  async settle() { await sleep(400); for (let i = 0; i < 100 && this.ev("busy"); i++) await sleep(20) }
  async login(email) { this.ev("AM='in';acr()"); this.w.document.getElementById("ae").value = email; this.w.document.getElementById("ap").value = "motdepasse"; await this.ev("doAuth('in')"); await this.settle(); return this.w.document.getElementById("am") ? this.w.document.getElementById("am").textContent : "" }
  async logout() { await this.ev("logout()"); await this.settle() }
  async win() { this.ev("start();cur=T;play(score(T),true)"); await this.settle(); return this.ev("H[0].w") }
  async sync() { await this.ev("sync(true)"); await this.settle() }
  words() { return this.ev("H.map(x=>x.w)") }
  stats() { return this.ev("({p:S.p,w:S.w,b:S.b})") }
  out() { return this.ev("typeof pend=='function'&&AU()?pend(AUTH.uid):-1") }
  keys() { const L = this.w.localStorage, k = []; for (let i = 0; i < L.length; i++) k.push(L.key(i)); return k.sort() }
  close() { this.w.close() }
}

/* ---------- Scénarios ---------- */
const results = []; let cur = "";
const ok = (cond, msg) => { results.push([cur, !!cond, msg]); };
const serverWords = email => { const id = (srv.users[email] || {}).id; return srv.games.filter(g => g.user_id == id).map(g => g.word) };

(async () => {
  const B = "benoit@test", Cm = "camille@test";
  addUser(B); addUser(Cm);
  const ipB = new Device("iPhone de Benoît"), mac = new Device("Mac");

  cur = "1. Jouer sur l'iPhone, retrouver sur le Mac";
  await ipB.login(B); const w1 = await ipB.win();
  await mac.login(B);
  ok(mac.words().includes(w1), "la partie de l'iPhone apparaît sur le Mac");
  ok(serverWords(B).length == 1, "une seule partie sur le serveur");

  cur = "2. Benoît se déconnecte de son iPhone, Camille s'y connecte";
  await ipB.logout();
  ok(!ipB.keys().some(k => k.includes(":cache")), "plus aucune copie de Benoît sur l'iPhone après déconnexion");
  await ipB.login(Cm);
  ok(ipB.words().length == 0, "Camille ne voit aucune partie de Benoît");
  ok(serverWords(Cm).length == 0, "rien n'est envoyé dans le compte de Camille");

  cur = "3. Camille joue sur l'iPhone de Benoît, puis Benoît revient";
  const wc = await ipB.win(); await ipB.logout(); await ipB.login(B);
  ok(JSON.stringify(serverWords(Cm)) == JSON.stringify([wc]), "la partie de Camille est dans son compte, et seulement elle");
  ok(ipB.words().length == 1 && ipB.words()[0] == w1, "Benoît retrouve exactement ses parties");

  cur = "4. Créer le compte du père de Benoît sur l'iPhone de Benoît";
  await ipB.logout();
  ipB.ev("AM='up';acr()"); ipB.w.document.getElementById("ae").value = "papa@test"; ipB.w.document.getElementById("ap").value = "motdepasse";
  await ipB.ev("doAuth('up')"); srv.users["papa@test"].confirmed = true; // il clique sur le lien
  await ipB.login("papa@test");
  ok(ipB.words().length == 0, "le nouveau compte est vide");
  const wp = await ipB.win();
  ok(JSON.stringify(serverWords("papa@test")) == JSON.stringify([wp]) && serverWords(B).length == 1, "sa partie va dans son compte, pas dans celui de Benoît");
  await ipB.logout(); await ipB.login(B);

  cur = "5. Partie sans réseau, puis retour du réseau";
  ipB.online = false; const w5 = await ipB.win();
  ok(ipB.out() == 1 && ipB.words().includes(w5), "la partie est visible et attend dans la boîte d'envoi");
  ipB.online = true; await ipB.sync();
  ok(serverWords(B).filter(x => x == w5).length == 1 && ipB.out() == 0, "elle part au serveur une seule fois");

  cur = "6. Partie sans réseau, session expirée, quelqu'un d'autre se connecte";
  ipB.online = false; const w6 = await ipB.win(); ipB.online = true;
  srv.failRefresh = true; ipB.ev("AUTH.exp=0"); await ipB.sync(); srv.failRefresh = false;
  ok(!ipB.ev("AU()"), "la session de Benoît est fermée");
  ok(ipB.words().length == 0, "l'écran ne montre plus les parties de Benoît");
  await ipB.login(Cm);
  ok(!serverWords(Cm).includes(w6), "la partie de Benoît ne part PAS dans le compte de Camille");
  ok(ipB.words().length == 1 && ipB.words()[0] == wc, "Camille ne voit que sa propre partie");
  await ipB.logout(); await ipB.login(B);
  ok(serverWords(B).includes(w6), "elle part dans le compte de Benoît à son retour");

  cur = "7. Envoi coupé après enregistrement, puis renvoi";
  srv.dropAfterWrite = true; const w7 = await ipB.win();
  ok(ipB.out() == 1, "l'appareil croit l'envoi raté et garde la partie");
  await ipB.sync();
  ok(serverWords(B).filter(x => x == w7).length == 1 && ipB.out() == 0, "le renvoi ne crée pas de doublon");

  cur = "8. Jouer sans compte, puis se connecter";
  const guest = new Device("Tablette");
  const wg = await guest.win();
  ok(guest.words().length == 1, "la partie sans compte s'affiche pendant la session");
  ok(!guest.keys().some(k => /:cache|:out|six:h$|six:s$|six:c$/.test(k)), "rien n'est gardé sur l'appareil");
  await guest.login(Cm);
  ok(!serverWords(Cm).includes(wg) && !guest.words().includes(wg), "la partie sans compte n'est pas rattachée au compte");

  cur = "9. Correction faite dans Supabase";
  const victim = srv.games.find(g => g.word == w7); srv.games = srv.games.filter(g => g !== victim);
  await ipB.sync(); await mac.sync(); await ipB.sync();
  ok(!ipB.words().includes(w7) && !mac.words().includes(w7), "la partie disparaît des deux appareils");
  ok(!srv.games.some(g => g.id == victim.id), "et ne revient jamais sur le serveur");

  cur = "10. La même note modifiée sur deux appareils sans réseau";
  ipB.ev(`C.ACCORD={w:"accord",n:6,rv:true,bx:0,due:0,note:""};typeof nbSet=="function"?nbSet("ACCORD"):save("c",C)`); await ipB.sync(); await mac.sync();
  mac.online = false; ipB.online = false;
  mac.ev(`cnote("ACCORD","note du Mac")`); await sleep(15); ipB.ev(`cnote("ACCORD","note de l'iPhone, plus récente")`);
  ipB.online = true; await ipB.sync(); mac.online = true; await mac.sync(); await ipB.sync();
  ok(mac.ev("C.ACCORD.note") == "note de l'iPhone, plus récente" && ipB.ev("C.ACCORD.note") == "note de l'iPhone, plus récente", "la plus récente gagne sur les deux appareils");

  cur = "11. L'iPhone de Camille avec l'ancienne version (données fantômes)";
  const camId = srv.users[Cm].id, before = serverWords(Cm).length;
  const old = new Device("iPhone de Camille", {
    "six:auth": JSON.stringify({ at: "x", rt: "y", exp: 0, uid: camId, email: Cm }),
    "six:own": JSON.stringify(camId),
    "six:h": JSON.stringify(Array.from({ length: 32 }, (_, i) => ({ w: "fantome", n: 7, r: 3, t: 60, d: new Date(2026, 9, 20, 10, i).toISOString() }))),
    "six:s": JSON.stringify({ p: 74, w: 71, c: 32, b: 32, d: [1, 11, 32, 15, 10, 2] }), "six:c": JSON.stringify({ ACCORD: { w: "accord", note: "Benoît" } })
  });
  await old.settle(); await old.login(Cm);
  ok(!old.keys().some(k => ["six:h", "six:s", "six:c", "six:own"].includes(k)), "l'ancienne copie locale est effacée au premier lancement");
  ok(serverWords(Cm).length == before && !serverWords(Cm).includes("fantome"), "aucune des 32 parties fantômes n'est renvoyée");
  ok(old.stats().p == serverWords(Cm).length, "Camille ne voit que ses vraies parties");

  cur = "12. Supprimer son compte";
  await old.ev("delAcc()"); await old.settle();
  ok(serverWords(Cm).length == 0 && !srv.users[Cm], "parties et compte effacés en ligne");
  ok(!old.keys().some(k => k.includes(camId)), "plus aucune trace sur l'appareil");

  cur = "13. Mot du jour et statistiques anciennes";
  srv.legacy[srv.users[B].id] = { played: 42, won: 39, total_seconds: 5000, won_seconds: 4500, dist: [0, 2, 6, 3, 3, 25].map((v, i) => i == 5 ? 0 : v).concat([]).slice(0, 6), best_streak: 30 };
  await mac.sync(); const hist = mac.ev("H.length"), s = mac.stats();
  ok(s.p == 42 + hist, "statistiques = report de 42 parties + historique (" + s.p + " = 42 + " + hist + ")");
  mac.ev("start();dmode=true;cur=T;play(score(T),true);dmode=false"); await mac.settle();
  ok(srv.games.some(g => g.daily), "une partie du mot du jour est enregistrée dans l'historique, marquée comme telle");

  [ipB, mac, guest, old].forEach(d => d.close());
  let last = ""; let bad = 0;
  for (const [sc, pass, msg] of results) { if (sc != last) { console.log("\n" + sc); last = sc } console.log((pass ? "  ✓ " : "  ✗ ") + msg); if (!pass) bad++ }
  console.log(`\n${results.length - bad}/${results.length} vérifications réussies`);
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error("ERREUR", e); process.exit(2) });
