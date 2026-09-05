/**
 * sprites — pixel art for the war room, drawn from string grids.
 *
 * Every sprite is a list of rows; each character indexes a palette, '.' (or
 * '-' in memorabilia.json) is transparent. Grids render to canvases at integer
 * scales with no smoothing, and to data-URL <img> tags for inline markup —
 * the page's CSP allows data: images but no external image hosts.
 *
 * Plain script (not a module) so app.js and game.js can call it directly.
 */

(function () {
  const C = {
    ink: '#08152B', orange: '#FF5F05', orangeDk: '#B8420A', harvest: '#FCB316',
    white: '#FFFFFF', cream: '#FFF3E0', creamDim: '#D8C4A6', patina: '#007E8E',
    patinaLt: '#35B8C4', prairie: '#006230', prairieLt: '#2EA05A', ground: '#13294B',
    tensor: '#B98CFF', gold: '#FFD34D', bronze: '#C8763A', pink: '#FF3E8C',
  };

  /** Shared letter palette used by the neo-retro grids. */
  const P = {
    k: C.ink, o: C.orange, O: C.orangeDk, h: C.harvest, w: C.white, c: C.cream, d: C.creamDim,
    p: C.patina, P: C.patinaLt, g: C.prairie, G: C.prairieLt, b: '#4A7BD6', B: C.ground,
    r: '#B8322B', t: C.tensor, y: C.gold, n: C.bronze, s: '#6E7A96', S: '#3A4560', f: '#F1B58C', F: '#C98761',
    x: C.pink, m: '#8C5A3C', M: '#5B3A26', l: '#6EC1FF', v: '#9DDB4A',
  };

  const DUCK = [
    '................', '.....kkkk.......', '....kyyyyk......', '...kyyyyyykk....',
    '...kyykyyyook...', '...kyyyyyyook...', '....kyyyykkk....', '.....kyyyk......',
    '..kkkkyyyykkk...', '.kyyyyyyyyyyyk..', '.kyyyyyyyyyyyk..', '..kyyyyyyyyyk...',
    '...kkyyyyykk....', '.....kookok.....', '....kookook.....', '....kkkkkkk.....',
  ];

  const TRAINER = [
    '.....kkkkkk.....', '....kooooook....', '...koooooooook..', '...kffffffffk...',
    '...kfkffkfffk...', '...kffffffffk...', '....kffkkffk....', '.....kkbbkk.....',
    '...kkbbbbbbkk...', '..kbbkbbbbkbbk..', '..kbbkbbbbkbbk..', '..kffkbbbbkffk..',
    '.....kSSSSk.....', '.....kSkkSk.....', '.....kSk.kSk....', '.....kkk.kkk....',
  ];

  const ALTGELD = [
    '...........r............', '..........rrr...........', '.........rrrrr..........', '........rrrrrrr.........',
    '.......rrrrrrrrr........', '......rrrrrrrrrrr.......', '.....rrrrrrrrrrrrr......', '....kkkkkkkkkkkkkkk.....',
    '....ksssssssssssssk.....', '....kskkskkskkskksk.....', '....kskkskkskkskksk.....', '....ksssssssssssssk.....',
    '....kssSsssSsssSssk.....', '....kssSsssSsssSssk.....', '....kssSsssSsssSssk.....', '....ksssssssssssssk.....',
    '....kssSsssSsssSssk.....', '....kssSsssSsssSssk.....', '....ksssssssssssssk.....', '.kkkkssssssssssssskkkk..',
    'kssssssssssssssssssssss.', 'kssSssSssssSssssSssSss..', 'kssSssSssssSssssSssSss..', 'kssssssssssssssssssssss.',
    'kssSssSssShhhSssSssSss..', 'kssSssSssShhhSssSssSss..', 'kssssssssShhhSsssssssss.', 'kkkkkkkkkkkkkkkkkkkkkkk.',
    '.GGGGGGGGGGGGGGGGGGGGGG.', '.GGGGGGGGGGGGGGGGGGGGGG.', '........................', '........................',
  ];

  /** Generic monument silhouettes for the collectible card, by kind. */
  const DOME = [
    '.........kkkkkk.........', '.......kkPPPPPPkk.......', '.....kkPPPPPPPPPPkk.....', '....kPPPPpPPPPpPPPPk....',
    '...kPPPPPpPPPPpPPPPPk...', '..kPPPPPPpPPPPpPPPPPPk..', '..kPPPPPPPPPPPPPPPPPPk..', '.kkkkkkkkkkkkkkkkkkkkkk.',
    '.kddddddddddddddddddddk.', '.kdkdkdkdkdkdkdkdkdkdkk.', '.kdkdkdkdkdkdkdkdkdkdkk.', '.krrrrrrrrrrrrrrrrrrrrk.',
    '.krrrrrrrrrrrrrrrrrrrrk.', '.krrkrrkrrkrrkrrkrrkrrk.', '.krrkrrkrrkrrkrrkrrkrrk.', '.krrrrrrrrrrrrrrrrrrrrk.',
    '.kkkkkkkkkkkkkkkkkkkkkk.', '.GGGGGGGGGGGGGGGGGGGGGG.', '........................', '........................',
  ];
  const TOWER = [
    '........kkkkkkkk........', '........kllllllk........', '........klkllklk........', '........kllllllk........',
    '........klkllklk........', '........kllllllk........', '...kkkkkkllllllkkkkkk...', '...kbbbbbbbbbbbbbbbbk...',
    '...kbkbbkbbkbbkbbkbbk...', '...kbkbbkbbkbbkbbkbbk...', '...kbbbbbbbbbbbbbbbbk...', '...kbkbbkbbkbbkbbkbbk...',
    '...kbkbbkbbkbbkbbkbbk...', '...kbbbbbbbbbbbbbbbbk...', '...kbkbbkbbkbbkbbkbbk...', '...kbbbbbhhbbbbbbbbbk...',
    '...kkkkkkkkkkkkkkkkkk...', '.GGGGGGGGGGGGGGGGGGGGGG.', '........................', '........................',
  ];
  const HALL = [
    '............kk..........', '...........kwwk.........', '..........kwwwwk........', '.....kkkkkkkwwkkkkkkk...',
    '....kSSSSSSSSSSSSSSSSk..', '...kSSSSSSSSSSSSSSSSSSk.', '..kkkkkkkkkkkkkkkkkkkkkk', '..krrrrrrrrrrrrrrrrrrrrk',
    '..krrwwrrwwrrwwrrwwrrrrk', '..krrwwrrwwrrwwrrwwrrrrk', '..krrrrrrrrrrrrrrrrrrrrk', '..krrwwrrwwrrwwrrwwrrrrk',
    '..krrwwrrwwrrwwrrwwrrrrk', '..krrrrrrrrrrrrrrrrrrrrk', '..krrwwrrwwrrrkkrrwwrrrk', '..krrwwrrwwrrrkkrrwwrrrk',
    '..kkkkkkkkkkkkkkkkkkkkkk', '.GGGGGGGGGGGGGGGGGGGGGG.', '........................', '........................',
  ];
  const BOWL = [
    '........................', '........................', 'kk....................kk', 'kck..................kck',
    'kcck................kcck', 'kcccck............kcccck', 'kccccck..........kccccck', 'kcccccck........kcccccck',
    'kccccccckkkkkkkkkcccccck', 'kcccccccGGGGGGGGGcccccck', 'kcccccccGoGGGGoGGcccccck', 'kcccccccGGGGGGGGGcccccck',
    'kcccccccGoGGGGoGGcccccck', 'kcccccccGGGGGGGGGcccccck', 'kkkkkkkkkkkkkkkkkkkkkkkk', '.rrrrrrrrrrrrrrrrrrrrrr.',
    '.rrrrrrrrrrrrrrrrrrrrrr.', '.GGGGGGGGGGGGGGGGGGGGGG.', '........................', '........................',
  ];
  const STATUE = [
    '..........kkk...........', '.........knnnk..........', '.........knknk..........', '.........knnnk..........',
    '....kkkkkkknnkkkkkkk....', '...knnnnnnnnnnnnnnnnk...', '....kkkkkknnnnkkkkkk....', '.........knnnnk.........',
    '.........knnnnk.........', '.........knnnnk.........', '........knnnnnnk........', '........knnnnnnk........',
    '.......kkkkkkkkkk.......', '......kSSSSSSSSSSk......', '......kSSSSSSSSSSk......', '.....kSSSSSSSSSSSSk.....',
    '.....kkkkkkkkkkkkkk.....', '.GGGGGGGGGGGGGGGGGGGGGG.', '........................', '........................',
  ];
  const MONUMENT_ART = { statue: STATUE, dome: DOME, belltower: ALTGELD, bowl: BOWL, hall: HALL, tower: TOWER };

  /** 8×8 HUD icons. */
  const ICON = {
    clock: ['.kkkkkk.', 'kwwwwwwk', 'kwwkwwwk', 'kwwkwwwk', 'kwwkkwwk', 'kwwwwwwk', '.kkkkkk.', '........'],
    pin:   ['..kkkk..', '.koook..', '.kokok..', '.koook..', '..kok...', '..kok...', '...k....', '........'],
    zap:   ['....hh..', '...hh...', '..hhhh..', '.hhhhh..', '...hh...', '..hh....', '.hh.....', '........'],
    shield:['.kkkkkk.', 'kPPPPPPk', 'kPPPPPPk', 'kPPPPPPk', '.kPPPPk.', '..kPPk..', '...kk...', '........'],
    star:  ['...y....', '..yyy...', '.yyyyy..', 'yyyyyyy.', '..yyy...', '.yy.yy..', 'y.....y.', '........'],
    heart: ['.xx.xx..', 'xxxxxxx.', 'xxxxxxx.', '.xxxxx..', '..xxx...', '...x....', '........', '........'],
    gift:  ['..h..h..', '.hhhhhh.', 'kkkkkkkk', 'koookook', 'kkkkkkkk', 'koookook', 'koookook', 'kkkkkkkk'],
    alert: ['...x....', '..xxx...', '..xkx...', '.xxkxx..', '.xxkxx..', 'xxxxxxx.', 'xxxkxxx.', 'xxxxxxx.'],
    gear:  ['..s..s..', '.ssssss.', 'ssskkss.', '.sskkss.', 'ssskkss.', '.ssssss.', '..s..s..', '........'],
    stop:  ['..PPPP..', '.PPPPPP.', 'PPkPPkPP', 'PPPPPPPP', 'PPPPPPPP', '.PPPPPP.', '..PPPP..', '........'],
    check: ['......G.', '.....GG.', '....GG..', 'G..GG...', 'GGGG....', '.GG.....', '........', '........'],
    cam:   ['.kk.....', 'kkkkkkkk', 'kwwwwwwk', 'kwkkkkwk', 'kwkwwkwk', 'kwkkkkwk', 'kwwwwwwk', 'kkkkkkkk'],
    box:   ['kkkkkkkk', 'kddddddk', 'kdkkkkdk', 'kdkddkdk', 'kdkkkkdk', 'kddddddk', 'kkkkkkkk', '........'],
    flag:  ['k.......', 'kooooo..', 'kooooooo', 'kooooo..', 'koooo...', 'k.......', 'k.......', 'k.......'],
    radio: ['..PPPP..', '.P....P.', 'P.PPPP.P', 'P.P..P.P', 'P.PPPP.P', '.P....P.', '..PPPP..', '........'],
    map:   ['kkkkkkkk', 'kGGkkGGk', 'kGGGGGGk', 'kkGGkkGk', 'kbbGkbbk', 'kbbbbbbk', 'kkkkkkkk', '........'],
    lock:  ['..kkkk..', '.kssssk.', '.ks..sk.', 'kkkkkkkk', 'khhhhhhk', 'khhkkhhk', 'khhhhhhk', 'kkkkkkkk'],
    crosshair:['...k....', '.kkkkk..', 'k.k.k.k.', 'kkk.kkk.', 'k.k.k.k.', '.kkkkk..', '...k....', '........'],
    users: ['.kk..kk.', 'kffkkffk', '.kk..kk.', 'kbbkkbbk', 'kbbkkbbk', 'kbbkkbbk', '........', '........'],
    inbox: ['kkkkkkkk', 'k......k', 'k......k', 'kk....kk', 'k.kkkk.k', 'k......k', 'kkkkkkkk', '........'],
    walk:  ['...oo...', '...oo...', '..kbbk..', '.k.bb.k.', '...bb...', '..kSSk..', '.kS..Sk.', '........'],
    expand:['kkk..kkk', 'k......k', 'k......k', '........', '........', 'k......k', 'k......k', 'kkk..kkk'],
    collapse:['..kkkk..', '..k..k..', 'kkk..kkk', 'k......k', 'k......k', 'kkk..kkk', '..k..k..', '..kkkk..'],
    refresh:['..kkkk..', '.k....kk', 'k....kkk', '........', '........', 'kkk....k', 'kk....k.', '..kkkk..'],
    volume:['...k....', '..kkk...', 'kkkkk.k.', 'kkkkk.k.', 'kkkkk.k.', '..kkk...', '...k....', '........'],
    cpu:   ['.k.kk.k.', 'kkkkkkkk', '.kwwwwk.', 'kkwkkwkk', 'kkwkkwkk', '.kwwwwk.', 'kkkkkkkk', '.k.kk.k.'],
    activity:['.......k', '......kk', '..k..k..', '.kkkkk..', 'kk..k...', 'k.......', '........', '........'],
    coffee:['.kkkkk..', '.kwwwkk.', '.kwowkwk', '.kwwwkwk', '.kwwwkk.', '.kkkkk..', 'sssssss.', '........'],
    duck:  ['..kkk...', '.kyyykk.', '.kykyyok', '..kyyk..', 'kkkyyykk', 'kyyyyyyk', '.kyyyyk.', '..kokok.'],
  };

  const canvasCache = new Map();
  const urlCache = new Map();

  /** Draws a grid at `scale` px per cell into a fresh canvas. */
  function draw(rows, pal, scale = 3) {
    const w = rows[0].length, h = rows.length;
    const c = document.createElement('canvas');
    c.width = w * scale; c.height = h * scale;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    for (let y = 0; y < h; y++) {
      const row = rows[y];
      let x = 0;
      while (x < w) {
        const ch = row[x];
        let run = 1;
        while (x + run < w && row[x + run] === ch) run++;
        const col = ch !== '.' && ch !== '-' ? pal[ch] : null;
        if (col) { ctx.fillStyle = col; ctx.fillRect(x * scale, y * scale, run * scale, scale); }
        x += run;
      }
    }
    return c;
  }

  /** memorabilia.json palettes are arrays indexed by a..h. */
  const arrayPalette = (arr) => Object.fromEntries(arr.map((hex, i) => [String.fromCharCode(97 + i), hex]));

  const items = new Map();       // id → { name, rarity, kind, drop, flavour, rows, pal }
  let gymBadges = {};

  const ready = fetch('/dashboard/gl/memorabilia.json')
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (!d) return;
      for (const it of d.items || []) {
        // One malformed entry must not blank the whole sticker book: validate
        // the 16x16 grid and palette here, skip and warn instead of throwing
        // later inside a render.
        const ok = it && typeof it.id === 'string' && Array.isArray(it.palette) && it.palette.length > 0
          && Array.isArray(it.pixel) && it.pixel.length === 16 && it.pixel.every((r) => typeof r === 'string' && r.length === 16);
        if (!ok) { console.warn('memorabilia: skipping malformed item', it && it.id); continue; }
        items.set(it.id, { ...it, rows: it.pixel, pal: arrayPalette(it.palette) });
      }
      gymBadges = Object.fromEntries(Object.entries(d.gym_badges || {}).filter(([k]) => !k.startsWith('_')));
    })
    .catch((err) => console.warn('memorabilia unavailable:', err.message));

  function cached(key, make) {
    let c = canvasCache.get(key);
    if (!c) { c = make(); canvasCache.set(key, c); }
    return c;
  }

  const api = {
    ready, P, DUCK, TRAINER, ICON, MONUMENT_ART,
    draw,
    items: () => Array.from(items.values()),
    item: (id) => items.get(id) || null,
    gymBadges: () => gymBadges,

    /** Canvas for a named thing: icon name, item id, 'duck', 'trainer', or a monument kind. */
    canvas(id, scale = 3) {
      return cached(`${id}@${scale}`, () => {
        if (ICON[id]) return draw(ICON[id], P, scale);
        if (id === 'duck') return draw(DUCK, P, scale);
        if (id === 'trainer') return draw(TRAINER, P, scale);
        if (MONUMENT_ART[id]) return draw(MONUMENT_ART[id], P, scale);
        const it = items.get(id);
        if (it) return draw(it.rows, it.pal, scale);
        return draw(ICON.box, P, scale);
      });
    },

    /** data: URL for inline <img>; cached, so markup rebuilds stay cheap. */
    url(id, scale = 3) {
      const key = `${id}@${scale}`;
      let u = urlCache.get(key);
      if (!u) { u = api.canvas(id, scale).toDataURL(); urlCache.set(key, u); }
      return u;
    },

    /** Inline <img> markup for a sprite. */
    img(id, scale = 3, cls = 'pxi', alt = '') {
      return `<img class="${cls}" alt="${alt}" src="${api.url(id, scale)}" width="${api.canvas(id, scale).width}" height="${api.canvas(id, scale).height}">`;
    },

    /** Mounts a sprite canvas into an element (replacing its content). */
    mount(el, id, scale = 3) {
      if (!el) return null;
      const c = api.canvas(id, scale).cloneNode(true);
      c.getContext('2d').drawImage(api.canvas(id, scale), 0, 0);
      c.className = 'pxi';
      el.replaceChildren(c);
      return c;
    },

    /** Renders an ImageData (e.g. the avatar head) as a scaled <img> URL. */
    imageDataURL(imageData, scale = 4) {
      const src = document.createElement('canvas');
      src.width = imageData.width; src.height = imageData.height;
      src.getContext('2d').putImageData(imageData, 0, 0);
      const out = document.createElement('canvas');
      out.width = src.width * scale; out.height = src.height * scale;
      const ctx = out.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(src, 0, 0, out.width, out.height);
      return out.toDataURL();
    },
  };

  window.Sprites = api;
})();
