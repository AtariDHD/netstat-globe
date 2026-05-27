/* global Globe */

(function () {
  const globeEl = document.getElementById('globe');
  const globeStage = globeEl ? globeEl.closest('.globe-stage') : null;
  const statusEl = document.getElementById('status');
  const countEl = document.getElementById('count');
  const errorEl = document.getElementById('error');

  const OPACITY = 0.5;

  const LS_COL_VIS_LIVE = 'netstatGlobeColVisLive';
  const LS_COL_VIS_HISTORY = 'netstatGlobeColVisHistory';
  const LS_SORT_KEY = 'netstatGlobeTableSortKey';
  const LS_SORT_DIR = 'netstatGlobeTableSortDir';
  const LS_POV = 'netstatGlobePov';
  const LS_GLOBE_THEME = 'netstatGlobeGlobeTheme';
  const LS_GLOBE_CLOUDS = 'netstatGlobeGlobeClouds';
  /** @deprecated migrated to LS_GLOBE_THEME value `realtime` */
  const LS_GLOBE_DAY_NIGHT_LEGACY = 'netstatGlobeGlobeDayNight';
  const GLOBE_THEME_REALTIME = 'realtime';
  const GLOBE_THEME_BOUNDARIES = 'boundaries';

  const GLOBE_TILE_ENGINE_URL = (x, y, l) =>
    `https://tile.openstreetmap.org/${l}/${x}/${y}.png`;

  const GLOBE_THEMES = {
    night: '//cdn.jsdelivr.net/npm/three-globe/example/img/earth-night.jpg',
    day: '//cdn.jsdelivr.net/npm/three-globe/example/img/earth-blue-marble.jpg',
  };

  const CLOUDS_IMG_URL = 'https://clouds.matteason.co.uk/images/8192x4096/clouds-alpha.png';
  const CLOUDS_ALT = 0.004;
  const CLOUDS_UPDATE_MS = 3 * 60 * 60 * 1000;

  const GLOBE_DAY_NIGHT_SHADER = {
    vertexShader: `
      varying vec3 vNormal;
      varying vec2 vUv;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      #define PI 3.141592653589793
      uniform sampler2D dayTexture;
      uniform sampler2D nightTexture;
      uniform vec2 sunPosition;
      uniform vec2 globeRotation;
      varying vec3 vNormal;
      varying vec2 vUv;

      float toRad(in float a) {
        return a * PI / 180.0;
      }

      vec3 Polar2Cartesian(in vec2 c) {
        float theta = toRad(90.0 - c.x);
        float phi = toRad(90.0 - c.y);
        return vec3(
          sin(phi) * cos(theta),
          cos(phi),
          sin(phi) * sin(theta)
        );
      }

      void main() {
        float invLon = toRad(globeRotation.x);
        float invLat = -toRad(globeRotation.y);
        mat3 rotX = mat3(
          1, 0, 0,
          0, cos(invLat), -sin(invLat),
          0, sin(invLat), cos(invLat)
        );
        mat3 rotY = mat3(
          cos(invLon), 0, sin(invLon),
          0, 1, 0,
          -sin(invLon), 0, cos(invLon)
        );
        vec3 rotatedSunDirection = rotX * rotY * Polar2Cartesian(sunPosition);
        float intensity = dot(normalize(vNormal), normalize(rotatedSunDirection));
        vec4 dayColor = texture2D(dayTexture, vUv);
        vec4 nightColor = texture2D(nightTexture, vUv);
        float blendFactor = smoothstep(-0.1, 0.1, intensity);
        gl_FragColor = mix(nightColor, dayColor, blendFactor);
      }
    `,
  };
  const DEFAULT_POV = { lat: 39.6, lng: -98.5, altitude: 2 };
  const LS_POLL_MS = 'netstatGlobePollMs';
  const POLL_MS_OPTIONS = [500, 1000, 2000, 3000, 5000, 10000, 30000];
  const TABLE_SORT_IDS = [
    'pid',
    'process',
    'protocol',
    'local',
    'remote',
    'remoteHost',
    'from',
    'to',
    'createTime',
    'elapsed',
  ];
  const LS_HISTORY_MAX_ROWS = 'netstatGlobeHistoryMaxRows';
  const LS_HISTORY_SORT_KEY = 'netstatGlobeHistorySortKey';
  const LS_HISTORY_SORT_DIR = 'netstatGlobeHistorySortDir';
  const LS_DRAWER_TAB = 'netstatGlobeDrawerTab';
  const LS_HIGHLIGHT_RULES = 'netstatGlobeHighlightRules';
  const LS_HIGHLIGHT_RULE_SETS = 'netstatGlobeHighlightRuleSets';
  const LS_PROTOCOL_FILTER_LIVE = 'netstatGlobeProtocolFilterLive';
  const LS_PROTOCOL_FILTER_HISTORY = 'netstatGlobeProtocolFilterHistory';
  const LS_LIVE_SEARCH = 'netstatGlobeLiveSearch';
  const LS_LIVE_SEARCH_MODE = 'netstatGlobeLiveSearchMode';
  const LS_CONNECTION_SOURCE = 'netstatGlobeConnectionSource';
  const LS_PEPWAVE_CONFIG = 'netstatGlobePepwaveConfig';
  const LIVE_SEARCH_COLS = ['process', 'local', 'remote', 'remoteHost', 'from', 'to'];
  const TABLE_HISTORY_SORT_IDS = [
    'time',
    'event',
    'pid',
    'process',
    'protocol',
    'local',
    'remote',
    'remoteHost',
    'from',
    'to',
  ];

  const SHARED_CONN_COL_IDS = ['pid', 'process', 'protocol', 'local', 'remote', 'remoteHost', 'from', 'to'];
  const LIVE_COL_IDS = [...SHARED_CONN_COL_IDS, 'createTime', 'elapsed'];
  const HIST_COL_IDS = ['time', 'event', ...SHARED_CONN_COL_IDS];

  const COL_DISPLAY_LABEL = {
    pid: 'PID',
    process: 'Process',
    protocol: 'Protocol',
    local: 'Local',
    remote: 'Remote',
    remoteHost: 'Remote Host',
    from: 'From',
    to: 'To',
    time: 'Time',
    event: 'Connection',
    createTime: 'Create Time',
    elapsed: 'Elapsed',
  };

  function defaultColVis(ids) {
    return Object.fromEntries(ids.map((id) => [id, true]));
  }

  function loadColVisLive() {
    const d = defaultColVis(LIVE_COL_IDS);
    try {
      const raw = localStorage.getItem(LS_COL_VIS_LIVE);
      if (raw) {
        const o = JSON.parse(raw);
        for (const id of LIVE_COL_IDS) {
          if (typeof o[id] === 'boolean') d[id] = o[id];
        }
      } else if (localStorage.getItem('netstatGlobeHideOriginCols') === '1') {
        d.local = false;
        d.from = false;
      }
    } catch {
      /* keep defaults */
    }
    return d;
  }

  function loadColVisHist() {
    const d = defaultColVis(HIST_COL_IDS);
    try {
      const raw = localStorage.getItem(LS_COL_VIS_HISTORY);
      if (raw) {
        const o = JSON.parse(raw);
        for (const id of HIST_COL_IDS) {
          if (typeof o[id] === 'boolean') d[id] = o[id];
        }
      } else if (localStorage.getItem('netstatGlobeHistoryHideOriginCols') === '1') {
        d.local = false;
        d.from = false;
      }
    } catch {
      /* keep defaults */
    }
    return d;
  }

  const colVisLive = loadColVisLive();
  const colVisHist = loadColVisHist();

  let lastConnections = [];
  let lastArcs = [];
  let tableSort = {
    key: localStorage.getItem(LS_SORT_KEY) || 'remote',
    dir: localStorage.getItem(LS_SORT_DIR) === 'desc' ? 'desc' : 'asc',
  };
  if (!TABLE_SORT_IDS.includes(tableSort.key)) tableSort.key = 'remote';

  let historyTableSort = {
    key: localStorage.getItem(LS_HISTORY_SORT_KEY) || 'time',
    dir: localStorage.getItem(LS_HISTORY_SORT_DIR) === 'asc' ? 'asc' : 'desc',
  };
  if (!TABLE_HISTORY_SORT_IDS.includes(historyTableSort.key)) historyTableSort.key = 'time';

  /** @type {Array<{ ts: number, event: string, process: string, protocol: string, local: string, remote: string, remoteHost: string, from: string, to: string, pid: number|null, pidStr: string }>} */
  let connectionHistory = [];

  const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProto}//${window.location.host}`;

  function hasWebGLSupport() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return false;
    if (!window.WebGLRenderingContext) return false;
    try {
      const canvas = document.createElement('canvas');
      const gl =
        canvas.getContext('webgl2') ||
        canvas.getContext('webgl') ||
        canvas.getContext('experimental-webgl');
      if (!gl) return false;
      const lose = gl.getExtension && gl.getExtension('WEBGL_lose_context');
      if (lose && typeof lose.loseContext === 'function') lose.loseContext();
      return true;
    } catch {
      return false;
    }
  }

  function renderWebGLUnsupportedMessage(targetEl) {
    if (!targetEl) return;
    targetEl.classList.add('webgl-unsupported');
    targetEl.setAttribute('role', 'alert');
    targetEl.innerHTML = `
      <div class="webgl-unsupported-card">
        <h2 class="webgl-unsupported-title">3D globe unavailable</h2>
        <p class="webgl-unsupported-body">
          Your browser does not have WebGL enabled, so the globe can't be rendered.
          Connections will still appear in the panel on the right.
        </p>
        <p class="webgl-unsupported-body">
          To see the globe, open this page in a browser that supports WebGL
          (Chrome, Edge, Firefox, or Safari) and make sure WebGL / hardware
          acceleration is enabled in the browser settings.
        </p>
        <p class="webgl-unsupported-help">
          You can verify WebGL support at
          <a href="https://get.webgl.org/" target="_blank" rel="noopener noreferrer">get.webgl.org</a>.
        </p>
      </div>
    `;
  }

  function createGlobeStub() {
    const stub = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') return undefined;
          return () => stub;
        },
      }
    );
    return stub;
  }

  function normalizeGlobeTheme(theme) {
    if (
      theme === GLOBE_THEME_REALTIME ||
      theme === GLOBE_THEME_BOUNDARIES ||
      theme === 'day' ||
      theme === 'night'
    ) {
      return theme;
    }
    return GLOBE_THEME_REALTIME;
  }

  function loadGlobeTheme() {
    try {
      if (localStorage.getItem(LS_GLOBE_DAY_NIGHT_LEGACY) === '1') {
        localStorage.removeItem(LS_GLOBE_DAY_NIGHT_LEGACY);
        localStorage.setItem(LS_GLOBE_THEME, GLOBE_THEME_REALTIME);
        return GLOBE_THEME_REALTIME;
      }
      return normalizeGlobeTheme(localStorage.getItem(LS_GLOBE_THEME));
    } catch {
      return GLOBE_THEME_REALTIME;
    }
  }

  function saveGlobeTheme(theme) {
    try {
      localStorage.setItem(LS_GLOBE_THEME, normalizeGlobeTheme(theme));
    } catch {
      /* ignore */
    }
  }

  function globeImageUrlForTheme(theme) {
    const t = normalizeGlobeTheme(theme);
    if (t === 'day') return GLOBE_THEMES.day;
    return GLOBE_THEMES.night;
  }

  let currentGlobeTheme = loadGlobeTheme();
  let globeDayNightMaterial = null;
  let globeDayNightStopRaf = null;
  let globeDayNightModulesPromise = null;
  let globeDayNightEnabling = false;
  let globeRealtimeLoadId = 0;

  let globeCloudsEnabled = false;
  let globeCloudsMesh = null;
  let globeCloudsTexture = null;
  let globeCloudsRefreshTimer = null;
  let globeCloudsLoading = false;

  function loadGlobeCloudsEnabled() {
    try {
      return localStorage.getItem(LS_GLOBE_CLOUDS) === '1';
    } catch {
      return false;
    }
  }

  function saveGlobeCloudsEnabled(enabled) {
    try {
      localStorage.setItem(LS_GLOBE_CLOUDS, enabled ? '1' : '0');
    } catch {
      /* ignore */
    }
  }

  function cloudsUrlForNow() {
    const bucket = Math.floor(Date.now() / CLOUDS_UPDATE_MS);
    return `${CLOUDS_IMG_URL}?v=${bucket}`;
  }

  function clearCloudsRefreshTimer() {
    if (globeCloudsRefreshTimer) clearTimeout(globeCloudsRefreshTimer);
    globeCloudsRefreshTimer = null;
  }

  function scheduleCloudsRefresh() {
    clearCloudsRefreshTimer();
    if (!globeCloudsEnabled) return;
    const now = Date.now();
    const next = (Math.floor(now / CLOUDS_UPDATE_MS) + 1) * CLOUDS_UPDATE_MS;
    const delay = Math.max(5000, next - now + 250);
    globeCloudsRefreshTimer = setTimeout(() => {
      refreshCloudsTexture();
    }, delay);
  }

  let cloudsThreePromise = null;
  function loadThreeForClouds() {
    if (!cloudsThreePromise) {
      cloudsThreePromise = import('https://esm.sh/three@0.180.0').then((t) => ({
        Mesh: t.Mesh,
        SphereGeometry: t.SphereGeometry,
        MeshPhongMaterial: t.MeshPhongMaterial,
        TextureLoader: t.TextureLoader,
      }));
    }
    return cloudsThreePromise;
  }

  function ensureCloudsMesh() {
    if (globeCloudsMesh) return Promise.resolve(globeCloudsMesh);
    if (!world || typeof world.scene !== 'function' || typeof world.getGlobeRadius !== 'function') {
      return Promise.resolve(null);
    }
    const r = Number(world.getGlobeRadius());
    if (!Number.isFinite(r) || r <= 0) return Promise.resolve(null);

    return loadThreeForClouds()
      .then(({ Mesh, SphereGeometry, MeshPhongMaterial }) => {
        if (globeCloudsMesh) return globeCloudsMesh;
        if (!globeCloudsEnabled) return null;

        const geom = new SphereGeometry(r * (1 + CLOUDS_ALT), 75, 75);
        const mat = new MeshPhongMaterial({
          transparent: true,
          opacity: 1,
          depthWrite: false,
        });
        const mesh = new Mesh(geom, mat);
        // Match three-globe's internal globe rotation (prime meridian facing Z)
        mesh.rotation.y = -Math.PI / 2;
        mesh.renderOrder = 10;

        world.scene().add(mesh);
        globeCloudsMesh = mesh;
        return mesh;
      })
      .catch(() => null);
  }

  function disposeClouds() {
    clearCloudsRefreshTimer();
    if (globeCloudsTexture && typeof globeCloudsTexture.dispose === 'function') {
      globeCloudsTexture.dispose();
    }
    globeCloudsTexture = null;

    if (globeCloudsMesh) {
      try {
        if (world && typeof world.scene === 'function') world.scene().remove(globeCloudsMesh);
      } catch {
        /* ignore */
      }
      try {
        if (globeCloudsMesh.geometry && typeof globeCloudsMesh.geometry.dispose === 'function') globeCloudsMesh.geometry.dispose();
        if (globeCloudsMesh.material && typeof globeCloudsMesh.material.dispose === 'function') globeCloudsMesh.material.dispose();
      } catch {
        /* ignore */
      }
      globeCloudsMesh = null;
    }
  }

  function refreshCloudsTexture() {
    if (!globeCloudsEnabled) return;
    if (globeCloudsLoading) return;
    globeCloudsLoading = true;
    Promise.all([ensureCloudsMesh(), loadThreeForClouds()])
      .then(([mesh, three]) => {
        if (!mesh || !globeCloudsEnabled) throw new Error('no mesh');
        const loader = new three.TextureLoader();
        try {
          loader.setCrossOrigin && loader.setCrossOrigin('anonymous');
        } catch {
          /* ignore */
        }
        return loader.loadAsync(cloudsUrlForNow()).then((tex) => ({ mesh, tex }));
      })
      .then(({ mesh, tex }) => {
        globeCloudsLoading = false;
        if (!globeCloudsEnabled || !globeCloudsMesh) {
          tex && tex.dispose && tex.dispose();
          return;
        }
        if (globeCloudsTexture && globeCloudsTexture.dispose) globeCloudsTexture.dispose();
        globeCloudsTexture = tex;
        if (mesh.material) {
          mesh.material.map = tex;
          mesh.material.needsUpdate = true;
        }
        scheduleCloudsRefresh();
      })
      .catch(() => {
        globeCloudsLoading = false;
        if (globeCloudsEnabled) scheduleCloudsRefresh();
      });
  }

  function setCloudsEnabled(enabled) {
    globeCloudsEnabled = !!enabled;
    saveGlobeCloudsEnabled(globeCloudsEnabled);
    if (globeCloudsEnabled) {
      refreshCloudsTexture();
    } else {
      disposeClouds();
    }
  }

  function sunPosAt(dt, solar) {
    const day = new Date(+dt).setUTCHours(0, 0, 0, 0);
    const t = solar.century(dt);
    const longitude = ((day - dt) / 864e5) * 360 - 180;
    return [longitude - solar.equationOfTime(t) / 4, solar.declination(t)];
  }

  function syncGlobeDayNightRotationUniform() {
    if (!globeDayNightMaterial) return;
    try {
      const pov = world.pointOfView();
      if (pov && Number.isFinite(pov.lng) && Number.isFinite(pov.lat)) {
        globeDayNightMaterial.uniforms.globeRotation.value.set(pov.lng, pov.lat);
      }
    } catch {
      /* ignore */
    }
  }

  function stopGlobeDayNightAnimation() {
    if (globeDayNightStopRaf) {
      globeDayNightStopRaf();
      globeDayNightStopRaf = null;
    }
  }

  function startGlobeDayNightAnimation(material, solar) {
    stopGlobeDayNightAnimation();
    let rafId = 0;
    const tick = () => {
      if (!globeDayNightMaterial || globeDayNightMaterial !== material) return;
      const dt = Date.now();
      material.uniforms.sunPosition.value.set(...sunPosAt(dt, solar));
      rafId = requestAnimationFrame(tick);
    };
    material.uniforms.sunPosition.value.set(...sunPosAt(Date.now(), solar));
    rafId = requestAnimationFrame(tick);
    globeDayNightStopRaf = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    };
  }

  function loadGlobeDayNightModules() {
    if (!globeDayNightModulesPromise) {
      globeDayNightModulesPromise = Promise.all([
        import('https://esm.sh/three@0.180.0'),
        import('https://esm.sh/solar-calculator@0.3'),
      ]).then(([threeMod, solarMod]) => ({
        TextureLoader: threeMod.TextureLoader,
        ShaderMaterial: threeMod.ShaderMaterial,
        Vector2: threeMod.Vector2,
        solar: solarMod,
      }));
    }
    return globeDayNightModulesPromise;
  }

  function disposeGlobeDayNightMaterial() {
    stopGlobeDayNightAnimation();
    if (!globeDayNightMaterial) return;
    const uniforms = globeDayNightMaterial.uniforms;
    if (uniforms) {
      if (uniforms.dayTexture && uniforms.dayTexture.value) uniforms.dayTexture.value.dispose();
      if (uniforms.nightTexture && uniforms.nightTexture.value) uniforms.nightTexture.value.dispose();
    }
    globeDayNightMaterial.dispose();
    globeDayNightMaterial = null;
  }

  function disableGlobeTileEngine() {
    if (!world) return;
    if (typeof world.globeTileEngineClearCache === 'function') {
      world.globeTileEngineClearCache();
    }
    if (typeof world.globeTileEngineUrl === 'function') {
      world.globeTileEngineUrl(null);
    }
  }

  function applyStaticGlobeTheme(theme) {
    if (!webGLSupported || !world) return;
    disableGlobeTileEngine();
    const url = globeImageUrlForTheme(theme);
    // globeMaterial(shader) replaces the default; globeImageUrl alone won't show static textures.
    if (typeof world.globeMaterial === 'function') {
      world.globeMaterial(null);
    }
    if (typeof world.globeImageUrl === 'function') {
      world.globeImageUrl(null);
      world.globeImageUrl(url);
    }
  }

  function applyBoundariesGlobeTheme() {
    if (!webGLSupported || !world) return;
    if (typeof world.globeMaterial === 'function') {
      world.globeMaterial(null);
    }
    disableGlobeTileEngine();
    if (typeof world.globeImageUrl === 'function') {
      world.globeImageUrl(null);
    }
    if (typeof world.globeTileEngineUrl === 'function') {
      world.globeTileEngineUrl(GLOBE_TILE_ENGINE_URL);
    }
  }

  function enableGlobeRealtimeShader() {
    if (!webGLSupported || globeDayNightEnabling) return Promise.resolve();
    const loadId = ++globeRealtimeLoadId;
    globeDayNightEnabling = true;
    disableGlobeTileEngine();
    return loadGlobeDayNightModules()
      .then(({ TextureLoader, ShaderMaterial, Vector2, solar }) => {
        if (loadId !== globeRealtimeLoadId || currentGlobeTheme !== GLOBE_THEME_REALTIME) return;
        disposeGlobeDayNightMaterial();
        const loader = new TextureLoader();
        return Promise.all([
          loader.loadAsync(GLOBE_THEMES.day),
          loader.loadAsync(GLOBE_THEMES.night),
        ]).then(([dayTexture, nightTexture]) => {
          if (loadId !== globeRealtimeLoadId || currentGlobeTheme !== GLOBE_THEME_REALTIME) {
            dayTexture.dispose();
            nightTexture.dispose();
            return;
          }
          const material = new ShaderMaterial({
            uniforms: {
              dayTexture: { value: dayTexture },
              nightTexture: { value: nightTexture },
              sunPosition: { value: new Vector2() },
              globeRotation: { value: new Vector2() },
            },
            vertexShader: GLOBE_DAY_NIGHT_SHADER.vertexShader,
            fragmentShader: GLOBE_DAY_NIGHT_SHADER.fragmentShader,
          });
          globeDayNightMaterial = material;
          if (typeof world.globeMaterial === 'function') {
            world.globeMaterial(material);
          }
          syncGlobeDayNightRotationUniform();
          startGlobeDayNightAnimation(material, solar);
        });
      })
      .catch((err) => {
        console.error('Globe day/night shader failed to load', err);
        currentGlobeTheme = 'night';
        saveGlobeTheme('night');
        const sel = document.getElementById('globe-theme');
        if (sel instanceof HTMLSelectElement) sel.value = 'night';
        syncGlobeAppearance('night');
      })
      .finally(() => {
        globeDayNightEnabling = false;
      });
  }

  function syncGlobeAppearance(theme) {
    const next = normalizeGlobeTheme(theme ?? loadGlobeTheme());
    currentGlobeTheme = next;
    if (!webGLSupported) return;
    if (next !== GLOBE_THEME_REALTIME) {
      globeRealtimeLoadId += 1;
    }
    if (next === GLOBE_THEME_REALTIME) {
      enableGlobeRealtimeShader();
    } else if (next === GLOBE_THEME_BOUNDARIES) {
      disposeGlobeDayNightMaterial();
      applyBoundariesGlobeTheme();
    } else {
      disposeGlobeDayNightMaterial();
      applyStaticGlobeTheme(next);
    }
  }

  const webGLSupported = hasWebGLSupport();
  const initialGlobeTheme = loadGlobeTheme();
  currentGlobeTheme = initialGlobeTheme;
  const world = webGLSupported
    ? new Globe(globeEl)
        .globeImageUrl(
          initialGlobeTheme === GLOBE_THEME_BOUNDARIES
            ? null
            : globeImageUrlForTheme(
                initialGlobeTheme === GLOBE_THEME_REALTIME ? 'night' : initialGlobeTheme
              )
        )
        .arcLabel('label')
        .arcDashLength(1)
        // arcColor / arcStroke set in syncArcStylesAndData() for hover highlighting
        .pointColor(() => 'orange')
        .pointAltitude(0)
        .pointRadius(0.02)
        .pointsMerge(true)
    : createGlobeStub();

  if (!webGLSupported) {
    renderWebGLUnsupportedMessage(globeEl);
  }

  globeCloudsEnabled = loadGlobeCloudsEnabled();

  function loadSavedPov() {
    try {
      const raw = localStorage.getItem(LS_POV);
      if (!raw) return null;
      const o = JSON.parse(raw);
      const lat = Number(o.lat);
      const lng = Number(o.lng);
      const altitude = Number(o.altitude);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
      if (!Number.isFinite(lng) || lng < -360 || lng > 360) return null;
      if (!Number.isFinite(altitude) || altitude <= 0 || altitude > 50) return null;
      return { lat, lng, altitude };
    } catch {
      return null;
    }
  }

  function savePovToStorage(pov) {
    if (!pov || typeof pov !== 'object') return;
    try {
      localStorage.setItem(
        LS_POV,
        JSON.stringify({
          lat: pov.lat,
          lng: pov.lng,
          altitude: pov.altitude,
        })
      );
    } catch {
      /* ignore */
    }
  }

  let povSaveTimer = null;
  let povPersistenceReady = false;

  function schedulePovSave(pov) {
    if (!povPersistenceReady) return;
    if (povSaveTimer) clearTimeout(povSaveTimer);
    povSaveTimer = setTimeout(() => {
      povSaveTimer = null;
      savePovToStorage(pov);
    }, 280);
  }

  if (typeof world.onZoom === 'function') {
    world.onZoom((pov) => {
      schedulePovSave(pov);
      if (globeDayNightMaterial && pov && Number.isFinite(pov.lng) && Number.isFinite(pov.lat)) {
        globeDayNightMaterial.uniforms.globeRotation.value.set(pov.lng, pov.lat);
      }
    });
  }

  window.addEventListener('pagehide', () => {
    try {
      const p = world.pointOfView();
      if (p && Number.isFinite(p.lat)) savePovToStorage(p);
    } catch {
      /* ignore */
    }
  });

  function layoutGlobe() {
    if (!globeEl) return;
    const stage = globeStage || globeEl.parentElement;
    const h =
      stage && stage.clientHeight > 0 ? stage.clientHeight : window.innerHeight;
    const w = Math.max(0, globeEl.clientWidth);
    globeEl.style.height = `${h}px`;
    world.width(w).height(h);
  }

  /** Stable arc objects by connection key so unchanged TCP rows keep the same THREE objects / arc state. */
  const arcByKey = new Map();

  const FLASH_MS = 4000;
  /** @type {Map<string, { kind: 'new'|'removed', until: number, removedConn?: object, removedArc?: object }>} */
  const flashState = new Map();
  let flashPruneTimer = null;

  let linkedHighlightKey = null;
  const LINK_OPACITY = Math.min(0.96, OPACITY + 0.44);
  const FLASH_NEW_OPACITY = Math.min(0.95, OPACITY + 0.4);

  const RULE_OPACITY = Math.min(0.96, OPACITY + 0.35);
  const NOTIFY_THROTTLE_MS = 10000;

  const FILTER_BY_OPTIONS = [
    { id: 'localIp', label: 'Local IP address' },
    { id: 'remoteIp', label: 'Remote IP address' },
    { id: 'remoteHostname', label: 'Remote hostname' },
    { id: 'remoteLocation', label: 'Remote location' },
    { id: 'adTrackerList', label: 'Ad Tracker List' },
  ];

  const AD_TRACKER_LISTS = [
    {
      id: 'easylist.to',
      label: 'easylist.to',
      url: 'https://easylist.to/easylist/easylist.txt',
    },
  ];

  /** @type {Map<string, { domains: Set<string>, loading?: boolean, error?: string }>} */
  const adTrackerListCache = new Map();
  /** @type {Map<string, Promise<Set<string>>>} */
  const adTrackerListLoads = new Map();

  const NOTIFICATION_OPTIONS = [
    { id: 'disabled', label: 'Disabled' },
    { id: 'browser', label: 'Web browser notification' },
  ];

  /** @type {Array<{ id: string, label: string, filterBy: string, useRegex?: boolean, filter: string, color: string, notification: string }>} */
  let highlightRules = [];
  /** @type {{ activeSetId: string|null, sets: Record<string, { id: string, name: string, rules: object[] }>, unsavedRules: object[]|null }} */
  let ruleSetsState = { activeSetId: null, sets: {}, unsavedRules: null };
  /** @type {Map<string, { color: string, ruleId: string, ruleLabel: string }>} */
  let matchStyleByConnectionKey = new Map();
  /** @type {{ lastSentAt: number, timer: any, pendingByRuleId: Map<string, number> }} */
  const notifyAgg = { lastSentAt: 0, timer: null, pendingByRuleId: new Map() };

  function safeRandomId() {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    } catch {
      /* ignore */
    }
    return `r_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  function defaultRule() {
    return {
      id: safeRandomId(),
      label: '',
      filterBy: 'remoteHostname',
      filter: '',
      color: '#22c55e',
      notification: 'disabled',
    };
  }

  function normalizeRule(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = typeof raw.id === 'string' && raw.id ? raw.id : safeRandomId();
    const label = raw.label != null ? String(raw.label) : '';
    const rawFilterBy = raw.filterBy === 'remoteIpRange' ? 'remoteIp' : raw.filterBy;
    const filterBy = FILTER_BY_OPTIONS.some((o) => o.id === rawFilterBy) ? rawFilterBy : 'remoteHostname';
    const filter = raw.filter != null ? String(raw.filter) : '';
    const color = typeof raw.color === 'string' && raw.color ? raw.color : '#22c55e';
    const notification = NOTIFICATION_OPTIONS.some((o) => o.id === raw.notification) ? raw.notification : 'disabled';
    return { id, label, filterBy, filter, color, notification };
  }

  function normalizeRulesArray(arr) {
    const out = [];
    if (!Array.isArray(arr)) return out;
    for (const r of arr) {
      const n = normalizeRule(r);
      if (n) out.push(n);
    }
    return out;
  }

  function cloneRule(r) {
    return { ...r, id: r.id || safeRandomId() };
  }

  function loadRuleSetsState() {
    try {
      const raw = localStorage.getItem(LS_HIGHLIGHT_RULE_SETS);
      if (raw) {
        const data = JSON.parse(raw);
        const sets = {};
        if (data && data.sets && typeof data.sets === 'object') {
          for (const [key, val] of Object.entries(data.sets)) {
            if (!val || typeof val !== 'object') continue;
            const id = typeof val.id === 'string' && val.id ? val.id : String(key);
            const name = val.name != null ? String(val.name).trim() : 'Unnamed';
            sets[id] = {
              id,
              name: name || 'Unnamed',
              rules: normalizeRulesArray(val.rules),
            };
          }
        }
        let activeSetId =
          data && data.activeSetId != null && String(data.activeSetId) ? String(data.activeSetId) : null;
        if (activeSetId && !sets[activeSetId]) activeSetId = null;
        const unsavedRules =
          data && Array.isArray(data.unsavedRules) ? normalizeRulesArray(data.unsavedRules) : null;
        return { activeSetId, sets, unsavedRules: unsavedRules && unsavedRules.length ? unsavedRules : null };
      }
    } catch {
      /* fall through to legacy */
    }

    try {
      const legacyRaw = localStorage.getItem(LS_HIGHLIGHT_RULES);
      if (legacyRaw) {
        const legacyRules = normalizeRulesArray(JSON.parse(legacyRaw));
        if (legacyRules.length) {
          const id = safeRandomId();
          return {
            activeSetId: id,
            sets: { [id]: { id, name: 'Default', rules: legacyRules } },
            unsavedRules: null,
          };
        }
      }
    } catch {
      /* ignore */
    }

    return { activeSetId: null, sets: {}, unsavedRules: null };
  }

  function saveRuleSetsState() {
    try {
      localStorage.setItem(
        LS_HIGHLIGHT_RULE_SETS,
        JSON.stringify({
          activeSetId: ruleSetsState.activeSetId,
          sets: ruleSetsState.sets,
          unsavedRules: ruleSetsState.unsavedRules,
        })
      );
      localStorage.removeItem(LS_HIGHLIGHT_RULES);
    } catch {
      /* ignore */
    }
  }

  function applyHighlightRulesFromState() {
    if (ruleSetsState.activeSetId && ruleSetsState.sets[ruleSetsState.activeSetId]) {
      highlightRules = ruleSetsState.sets[ruleSetsState.activeSetId].rules.map(cloneRule);
      ruleSetsState.unsavedRules = null;
      return;
    }
    if (ruleSetsState.unsavedRules && ruleSetsState.unsavedRules.length) {
      highlightRules = ruleSetsState.unsavedRules.map(cloneRule);
      return;
    }
    highlightRules = [];
  }

  function saveHighlightRules() {
    if (ruleSetsState.activeSetId && ruleSetsState.sets[ruleSetsState.activeSetId]) {
      ruleSetsState.sets[ruleSetsState.activeSetId].rules = highlightRules.map(cloneRule);
      ruleSetsState.unsavedRules = null;
    } else {
      ruleSetsState.unsavedRules = highlightRules.length ? highlightRules.map(cloneRule) : null;
    }
    saveRuleSetsState();
  }

  function setRuleSetsStatus(text) {
    const el = document.getElementById('rule-sets-status');
    if (!el) return;
    if (!text) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.hidden = false;
    el.textContent = text;
  }

  function sortedRuleSets() {
    return Object.values(ruleSetsState.sets).sort((a, b) =>
      String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' })
    );
  }

  function findRuleSetByName(name) {
    const n = String(name || '').trim().toLowerCase();
    if (!n) return null;
    for (const set of Object.values(ruleSetsState.sets)) {
      if (String(set.name).trim().toLowerCase() === n) return set;
    }
    return null;
  }

  function preloadAdTrackerListsForRules(rules) {
    for (const r of rules || []) {
      if (r && r.filterBy === 'adTrackerList' && r.filter) {
        loadAdTrackerList(r.filter).catch(() => {});
      }
    }
  }

  function syncRuleSetsUi() {
    const sel = document.getElementById('rule-set-active');
    const nameInp = document.getElementById('rule-set-name');
    const delBtn = document.getElementById('rule-set-delete');
    const sets = sortedRuleSets();

    if (sel instanceof HTMLSelectElement) {
      const prev = sel.value;
      sel.replaceChildren();
      const none = document.createElement('option');
      none.value = '';
      none.textContent = sets.length ? '— Unsaved draft —' : '— None —';
      sel.appendChild(none);
      for (const set of sets) {
        const o = document.createElement('option');
        o.value = set.id;
        o.textContent = set.name;
        sel.appendChild(o);
      }
      if (ruleSetsState.activeSetId && ruleSetsState.sets[ruleSetsState.activeSetId]) {
        sel.value = ruleSetsState.activeSetId;
      } else {
        sel.value = '';
      }
      if (!sel.value && prev && [...sel.options].some((o) => o.value === prev)) {
        sel.value = prev;
      }
    }

    if (nameInp instanceof HTMLInputElement) {
      const active =
        ruleSetsState.activeSetId && ruleSetsState.sets[ruleSetsState.activeSetId]
          ? ruleSetsState.sets[ruleSetsState.activeSetId]
          : null;
      nameInp.value = active ? active.name : '';
      nameInp.placeholder = sets.length ? 'Name for this rule set' : 'Name to save new rule set';
    }

    if (delBtn instanceof HTMLButtonElement) {
      delBtn.disabled = !(ruleSetsState.activeSetId && ruleSetsState.sets[ruleSetsState.activeSetId]);
    }
  }

  function switchActiveRuleSet(setId) {
    saveHighlightRules();
    ruleSetsState.activeSetId = setId && ruleSetsState.sets[setId] ? setId : null;
    applyHighlightRulesFromState();
    preloadAdTrackerListsForRules(highlightRules);
    syncRuleSetsUi();
    renderSettingsRules();
    refreshTableAndArcs();
  }

  function saveNamedRuleSet() {
    const nameInp = document.getElementById('rule-set-name');
    const name = nameInp instanceof HTMLInputElement ? nameInp.value.trim() : '';
    if (!name) {
      setRuleSetsStatus('Enter a name for the rule set.');
      return;
    }

    saveHighlightRules();

    let target = findRuleSetByName(name);
    if (target) {
      target.rules = highlightRules.map(cloneRule);
      target.name = name;
      ruleSetsState.activeSetId = target.id;
    } else {
      const id = safeRandomId();
      target = { id, name, rules: highlightRules.map(cloneRule) };
      ruleSetsState.sets[id] = target;
      ruleSetsState.activeSetId = id;
    }
    ruleSetsState.unsavedRules = null;
    saveRuleSetsState();
    setRuleSetsStatus(`Saved rule set "${name}".`);
    syncRuleSetsUi();
    renderSettingsRules();
    refreshTableAndArcs();
  }

  function deleteActiveRuleSet() {
    const id = ruleSetsState.activeSetId;
    if (!id || !ruleSetsState.sets[id]) {
      setRuleSetsStatus('Select a saved rule set to delete.');
      return;
    }
    const name = ruleSetsState.sets[id].name;
    delete ruleSetsState.sets[id];
    const remaining = sortedRuleSets();
    ruleSetsState.activeSetId = remaining.length ? remaining[0].id : null;
    applyHighlightRulesFromState();
    preloadAdTrackerListsForRules(highlightRules);
    saveRuleSetsState();
    setRuleSetsStatus(`Deleted rule set "${name}".`);
    syncRuleSetsUi();
    renderSettingsRules();
    refreshTableAndArcs();
  }

  function initRuleSetsUi() {
    const sel = document.getElementById('rule-set-active');
    const saveBtn = document.getElementById('rule-set-save');
    const delBtn = document.getElementById('rule-set-delete');

    if (sel instanceof HTMLSelectElement) {
      sel.addEventListener('change', () => {
        const v = sel.value;
        switchActiveRuleSet(v || null);
        setRuleSetsStatus('');
      });
    }
    if (saveBtn) saveBtn.addEventListener('click', () => saveNamedRuleSet());
    if (delBtn) delBtn.addEventListener('click', () => deleteActiveRuleSet());
    syncRuleSetsUi();
  }

  function isRuleFilled(r) {
    if (!r) return false;
    if (r.filterBy === 'adTrackerList') {
      const listId = String(r.filter || '').trim();
      if (!listId) return false;
      const cached = adTrackerListCache.get(listId);
      return !!(cached && cached.domains && cached.domains.size > 0);
    }
    return !!(typeof r.filter === 'string' && r.filter.trim() !== '');
  }

  function normalizeHostnameForMatch(hostname) {
    let h = String(hostname || '')
      .trim()
      .toLowerCase();
    if (!h || h === '—') return '';
    if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
    const colon = h.lastIndexOf(':');
    if (colon > 0 && h.indexOf('.') === -1 && h.includes(':')) {
      h = h.slice(0, colon);
    }
    return h.replace(/\.$/, '');
  }

  /** Extract blockable hostnames from Adblock Plus / EasyList filter text. */
  function parseEasyListDomains(text) {
    const domains = new Set();
    for (const rawLine of String(text || '').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('!')) continue;
      if (line.startsWith('@@') || line.startsWith('##') || line.startsWith('#@#')) continue;

      let candidate = null;
      if (line.startsWith('||')) {
        let rest = line.slice(2);
        const end = rest.search(/[\^\/\$\|]/);
        const chunk = (end === -1 ? rest : rest.slice(0, end)).trim();
        candidate = chunk;
      } else {
        const urlAnchor = line.match(/^\|https?:\/\/([^\/\^\$\|]+)/i);
        if (urlAnchor) candidate = urlAnchor[1];
      }
      if (!candidate) continue;

      let host = candidate.split('/')[0].split(':')[0].trim().toLowerCase();
      if (host.startsWith('*.')) host = host.slice(2);
      if (!host || !host.includes('.')) continue;
      if (!/^[\w.*-]+(\.[\w.*-]+)+$/.test(host)) continue;
      if (host.includes('*')) continue;
      domains.add(host);
    }
    return domains;
  }

  function hostnameMatchesAdTrackerList(hostname, domains) {
    const h = normalizeHostnameForMatch(hostname);
    if (!h || !domains || domains.size === 0) return false;
    if (domains.has(h)) return true;
    let dot = h.indexOf('.');
    while (dot !== -1) {
      const suffix = h.slice(dot + 1);
      if (domains.has(suffix)) return true;
      dot = h.indexOf('.', dot + 1);
    }
    return false;
  }

  function adTrackerListMeta(listId) {
    return AD_TRACKER_LISTS.find((x) => x.id === listId) || null;
  }

  async function fetchAdTrackerListText(listId) {
    const meta = adTrackerListMeta(listId);
    if (!meta) throw new Error('Unknown ad tracker list');

    try {
      const direct = await fetch(meta.url, { cache: 'no-store' });
      if (direct.ok) return direct.text();
    } catch {
      /* try same-origin proxy */
    }

    const proxied = await fetch(`/api/blocklist/${encodeURIComponent(listId)}`, { cache: 'no-store' });
    if (!proxied.ok) {
      let detail = `HTTP ${proxied.status}`;
      try {
        const j = await proxied.json();
        if (j && j.error) detail = String(j.error);
      } catch {
        /* ignore */
      }
      throw new Error(detail);
    }
    return proxied.text();
  }

  function loadAdTrackerList(listId) {
    const id = String(listId || '').trim();
    if (!id || !adTrackerListMeta(id)) return Promise.resolve(null);

    const existing = adTrackerListCache.get(id);
    if (existing && existing.domains && existing.domains.size > 0) {
      return Promise.resolve(existing.domains);
    }

    const inflight = adTrackerListLoads.get(id);
    if (inflight) return inflight;

    const meta = adTrackerListMeta(id);
    adTrackerListCache.set(id, { domains: new Set(), loading: true });

    const promise = (async () => {
      showCopyToast(`Retrieving ${meta.label}…`);
      try {
        const text = await fetchAdTrackerListText(id);
        const domains = parseEasyListDomains(text);
        adTrackerListCache.set(id, { domains });
        showCopyToast(`${meta.label} loaded (${domains.size.toLocaleString()} domains)`);
        syncAddRuleButtonDisabled();
        refreshTableAndArcs();
        return domains;
      } catch (e) {
        adTrackerListCache.set(id, { domains: new Set(), error: String(e.message || e) });
        showCopyToast(`Could not load ${meta.label}: ${String(e.message || e)}`);
        syncAddRuleButtonDisabled();
        throw e;
      } finally {
        adTrackerListLoads.delete(id);
      }
    })();

    adTrackerListLoads.set(id, promise);
    return promise;
  }

  function hexToRgba(hex, alpha) {
    const h = String(hex || '').trim();
    const m = h.match(/^#?([0-9a-f]{6})$/i);
    if (!m) return `rgba(56, 189, 248, ${alpha})`;
    const int = parseInt(m[1], 16);
    const r = (int >> 16) & 255;
    const g = (int >> 8) & 255;
    const b = int & 255;
    const a = Math.max(0, Math.min(1, Number(alpha)));
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }

  function parseIpv4ToInt(ip) {
    const parts = String(ip || '').trim().split('.');
    if (parts.length !== 4) return null;
    let out = 0;
    for (const p of parts) {
      if (!/^\d+$/.test(p)) return null;
      const n = Number(p);
      if (!Number.isFinite(n) || n < 0 || n > 255) return null;
      out = (out << 8) + n;
    }
    return out >>> 0;
  }

  function parseIpRangeSpec(spec) {
    const s = String(spec || '').trim();
    if (!s) return null;
    const cidr = s.match(/^(\d{1,3}(?:\.\d{1,3}){3})\s*\/\s*(\d{1,2})$/);
    if (cidr) {
      const base = parseIpv4ToInt(cidr[1]);
      const bits = Number(cidr[2]);
      if (base == null || !Number.isFinite(bits) || bits < 0 || bits > 32) return null;
      const mask = bits === 0 ? 0 : ((0xffffffff << (32 - bits)) >>> 0);
      return { kind: 'cidr', base, mask };
    }
    const range = s.match(/^(\d{1,3}(?:\.\d{1,3}){3})\s*-\s*(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (range) {
      const a = parseIpv4ToInt(range[1]);
      const b = parseIpv4ToInt(range[2]);
      if (a == null || b == null) return null;
      return { kind: 'range', start: Math.min(a, b), end: Math.max(a, b) };
    }
    const single = parseIpv4ToInt(s);
    if (single != null) return { kind: 'single', ip: single };
    return null;
  }

  function remoteLocationForConnectionKey(connectionKey, placesByKey, arcsByKey) {
    const p = placesByKey && connectionKey ? placesByKey.get(connectionKey) : null;
    if (p && p.end && p.end !== '—') return String(p.end);
    const arc = arcsByKey && connectionKey ? arcsByKey.get(connectionKey) : null;
    if (arc && arc.endPlace) return String(arc.endPlace);
    if (arc && arc.remoteCountry) return String(arc.remoteCountry);
    return '';
  }

  function getRuleFieldValue(rule, conn, placesByKey, arcsByKey) {
    const which = rule && rule.filterBy ? String(rule.filterBy) : '';
    if (which === 'remoteHostname') return String(conn && conn.remoteHost ? conn.remoteHost : '');
    if (which === 'remoteLocation') {
      const ck = conn && conn.connectionKey ? String(conn.connectionKey) : '';
      return remoteLocationForConnectionKey(ck, placesByKey, arcsByKey);
    }
    if (which === 'remoteIp') return String(conn && conn.remoteAddress ? conn.remoteAddress : '');
    if (which === 'localIp') return String(conn && conn.localAddress ? conn.localAddress : '');
    return '';
  }

  function parseFilterCsv(filter) {
    return String(filter || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function parseSlashRegex(expr) {
    const s = String(expr || '').trim();
    if (s.length < 2) return null;
    if (!s.startsWith('/') || !s.endsWith('/')) return null;
    const body = s.slice(1, -1);
    if (!body) return null;
    try {
      return new RegExp(body, 'i');
    } catch {
      return null;
    }
  }

  function escapeRegexLiteral(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function wildcardExprToRegex(expr) {
    // '*' matches 1+ characters (not 0+), case-insensitive by caller.
    const parts = String(expr || '').split('*').map(escapeRegexLiteral);
    if (parts.length === 1) return null;
    return new RegExp(parts.join('.+'), 'i');
  }

  function matchesTextOrWildcard(value, expr) {
    const v = String(value || '').trim();
    const e = String(expr || '').trim();
    if (!v || !e) return false;
    const re = wildcardExprToRegex(e);
    if (re) return re.test(v);
    return v.toLowerCase().includes(e.toLowerCase());
  }

  function ipWildcardMatches(ip, expr) {
    const p = String(expr || '').trim();
    if (!p.includes('*')) return false;
    const ipParts = String(ip || '').trim().split('.');
    const patParts = p.split('.');
    if (ipParts.length !== 4) return false;
    if (patParts.length < 1 || patParts.length > 4) return false;
    for (let i = 0; i < patParts.length; i++) {
      const seg = patParts[i].trim();
      if (seg === '*') return true; // match rest
      if (!/^\d{1,3}$/.test(seg)) return false;
      const n = Number(seg);
      if (!Number.isFinite(n) || n < 0 || n > 255) return false;
      if (ipParts[i] !== String(n)) return false;
    }
    // If pattern is shorter than 4 without '*' it must match exact prefix; treat as no-match.
    return patParts.length === 4;
  }

  function matchesRemoteIp(ip, expr) {
    const ipStr = String(ip || '').trim();
    if (!ipStr) return false;
    const re = parseSlashRegex(expr);
    if (re) return re.test(ipStr);

    const parsed = parseIpRangeSpec(expr);
    if (parsed) {
      const ipInt = parseIpv4ToInt(ipStr);
      if (ipInt == null) return false;
      if (parsed.kind === 'single') return ipInt === parsed.ip;
      if (parsed.kind === 'range') return ipInt >= parsed.start && ipInt <= parsed.end;
      if (parsed.kind === 'cidr') return ((ipInt & parsed.mask) >>> 0) === ((parsed.base & parsed.mask) >>> 0);
      return false;
    }
    if (ipWildcardMatches(ipStr, expr)) return true;
    return false;
  }

  function ruleMatchesConnection(rule, conn, placesByKey, arcsByKey) {
    if (!rule || !conn) return false;

    if (rule.filterBy === 'adTrackerList') {
      const listId = String(rule.filter || '').trim();
      if (!listId) return false;
      const cached = adTrackerListCache.get(listId);
      if (!cached || !cached.domains || cached.domains.size === 0) return false;
      const hostname = String(conn && conn.remoteHost ? conn.remoteHost : '').trim();
      if (!hostname || hostname === '—') return false;
      return hostnameMatchesAdTrackerList(hostname, cached.domains);
    }

    const value = String(getRuleFieldValue(rule, conn, placesByKey, arcsByKey) || '').trim();
    if (!value || value === '—') return false;

    const list = parseFilterCsv(rule.filter);
    if (list.length === 0) return false;

    // Regex mode: expr is /.../ (always case-insensitive)
    for (const expr of list) {
      const re = parseSlashRegex(expr);
      if (re) {
        if (re.test(value)) return true;
        continue;
      }

      if (String(rule.filterBy) === 'remoteIp' || String(rule.filterBy) === 'localIp') {
        if (matchesRemoteIp(value, expr)) return true;
        continue;
      }

      if (matchesTextOrWildcard(value, expr)) return true;
    }
    return false;
  }

  function computeMatchStyles(connections, placesByKey, arcsByKey) {
    const out = new Map();
    const rows = connections || [];
    for (const c of rows) {
      const ck = c && c.connectionKey != null ? String(c.connectionKey) : '';
      if (!ck) continue;
      for (const r of highlightRules) {
        if (!isRuleFilled(r)) continue;
        if (ruleMatchesConnection(r, c, placesByKey, arcsByKey)) {
          out.set(ck, {
            color: r.color || '#22c55e',
            ruleId: r.id,
            ruleLabel: ruleDisplayLabel(r),
          });
          break;
        }
      }
    }
    return out;
  }

  function setNotificationStatus(text) {
    const el = document.getElementById('settings-notification-status');
    if (!el) return;
    if (!text) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.hidden = false;
    el.textContent = text;
  }

  async function ensureNotificationPermissionIfNeeded() {
    if (typeof Notification === 'undefined') {
      setNotificationStatus('Browser notifications are not supported in this browser.');
      return 'unsupported';
    }
    if (Notification.permission === 'granted') {
      setNotificationStatus('');
      return 'granted';
    }
    if (Notification.permission === 'denied') {
      setNotificationStatus('Browser notifications are blocked. Enable them in your browser site settings to use notifications.');
      return 'denied';
    }
    try {
      const res = await Notification.requestPermission();
      if (res === 'granted') setNotificationStatus('');
      else setNotificationStatus('Browser notifications are not enabled yet.');
      return res;
    } catch {
      setNotificationStatus('Could not request browser notification permission.');
      return 'error';
    }
  }

  function ruleDisplayLabel(r) {
    const t = r && r.label != null ? String(r.label).trim() : '';
    return t || 'Unnamed rule';
  }

  function scheduleNotificationFlush() {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;
    if (notifyAgg.timer) return;
    const now = Date.now();
    const nextAt = Math.max(notifyAgg.lastSentAt + NOTIFY_THROTTLE_MS, now + 500);
    notifyAgg.timer = setTimeout(() => {
      notifyAgg.timer = null;
      flushNotificationsNow();
    }, Math.max(0, nextAt - now));
  }

  function flushNotificationsNow() {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;
    const entries = Array.from(notifyAgg.pendingByRuleId.entries()).filter(([, c]) => (c || 0) > 0);
    if (entries.length === 0) return;

    const total = entries.reduce((a, [, c]) => a + (c || 0), 0);
    const title = 'Netstat Globe';
    let body = '';

    if (entries.length === 1) {
      const [ruleId, count] = entries[0];
      const r = highlightRules.find((x) => x && x.id === ruleId) || null;
      const label = ruleDisplayLabel(r);
      body = `${count} connection${count === 1 ? '' : 's'} matching rule: "${label}".`;
    } else {
      body = `${total} connection${total === 1 ? '' : 's'} matching several network notification rules.`;
    }

    try {
      new Notification(title, { body });
      notifyAgg.lastSentAt = Date.now();
    } catch {
      /* ignore */
    } finally {
      notifyAgg.pendingByRuleId.clear();
    }
  }

  function enqueueRuleNotification(ruleId) {
    const prev = notifyAgg.pendingByRuleId.get(ruleId) || 0;
    notifyAgg.pendingByRuleId.set(ruleId, prev + 1);
    scheduleNotificationFlush();
  }

  function maybeNotifyForConnection(conn, placesByKey, arcsByKey) {
    if (!conn || typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;
    for (const r of highlightRules) {
      if (!r || r.notification !== 'browser') continue;
      if (!isRuleFilled(r)) continue;
      if (!ruleMatchesConnection(r, conn, placesByKey, arcsByKey)) continue;
      enqueueRuleNotification(r.id);
    }
  }

  function syncAddRuleButtonDisabled() {
    const addBtn = document.getElementById('settings-add-rule');
    if (!addBtn) return;
    if (highlightRules.length === 0) {
      addBtn.disabled = false;
      return;
    }
    const last = highlightRules[highlightRules.length - 1];
    addBtn.disabled = !isRuleFilled(last);
  }

  function renderSettingsRules() {
    const host = document.getElementById('settings-rules');
    const addBtn = document.getElementById('settings-add-rule');
    const emptyEl = document.getElementById('settings-rules-empty');
    if (!host || !addBtn) return;

    if (emptyEl) emptyEl.hidden = highlightRules.length > 0;

    host.replaceChildren();
    const tpl = document.getElementById('settings-rule-template');

    function syncAddDisabled() {
      syncAddRuleButtonDisabled();
      if (emptyEl) emptyEl.hidden = highlightRules.length > 0;
    }

    if (highlightRules.length === 0) {
      syncAddDisabled();
      return;
    }

    function fillSelect(sel, options, value) {
      if (!sel) return;
      sel.replaceChildren();
      for (const opt of options) {
        const o = document.createElement('option');
        o.value = opt.id;
        o.textContent = opt.label;
        sel.appendChild(o);
      }
      sel.value = value;
    }

    highlightRules.forEach((r, idx) => {
      let card = null;
      if (tpl && tpl instanceof HTMLTemplateElement && tpl.content) {
        const frag = tpl.content.cloneNode(true);
        card = frag.querySelector('.settings-rule');
        if (!card) {
          host.appendChild(frag);
          card = host.lastElementChild;
        } else {
          host.appendChild(frag);
        }
      } else {
        // Fallback: if template is missing, don't crash the settings panel.
        card = document.createElement('div');
        card.className = 'settings-rule';
        host.appendChild(card);
      }

      card.setAttribute('data-rule-id', r.id);

      const titleEl = card.querySelector('[data-role="rule-title"]');
      if (titleEl) titleEl.textContent = `Rule ${idx + 1}`;

      const removeBtn = card.querySelector('[data-role="rule-remove"]');
      if (removeBtn) {
        removeBtn.addEventListener('click', () => {
          highlightRules = highlightRules.filter((x) => x.id !== r.id);
          saveHighlightRules();
          renderSettingsRules();
          refreshTableAndArcs();
        });
      }

      const labelInp = card.querySelector('[data-role="rule-label"]');
      if (labelInp instanceof HTMLInputElement) {
        labelInp.value = r.label || '';
        labelInp.addEventListener('input', () => {
          r.label = labelInp.value;
          saveHighlightRules();
        });
      }

      const filterBySel = card.querySelector('[data-role="rule-filter-by"]');
      const filterLabelEl = card.querySelector('[data-role="rule-filter-label"]');
      const filterInp = card.querySelector('[data-role="rule-filter"]');
      const filterListSel = card.querySelector('[data-role="rule-filter-list"]');
      const isAdTrackerList = r.filterBy === 'adTrackerList';

      if (filterLabelEl) {
        filterLabelEl.textContent = isAdTrackerList ? 'List' : 'Filter';
      }

      if (filterBySel instanceof HTMLSelectElement) {
        fillSelect(filterBySel, FILTER_BY_OPTIONS, r.filterBy);
        filterBySel.addEventListener('change', () => {
          const prev = r.filterBy;
          r.filterBy = filterBySel.value;
          if (r.filterBy === 'adTrackerList' && prev !== 'adTrackerList') {
            r.filter = AD_TRACKER_LISTS[0] ? AD_TRACKER_LISTS[0].id : '';
          } else if (prev === 'adTrackerList' && r.filterBy !== 'adTrackerList') {
            r.filter = '';
          }
          saveHighlightRules();
          renderSettingsRules();
          refreshTableAndArcs();
        });
      }

      const notifSel = card.querySelector('[data-role="rule-notifications"]');
      if (notifSel instanceof HTMLSelectElement) {
        fillSelect(notifSel, NOTIFICATION_OPTIONS, r.notification);
        notifSel.addEventListener('change', async () => {
          r.notification = notifSel.value;
          saveHighlightRules();
          if (r.notification === 'browser') {
            await ensureNotificationPermissionIfNeeded();
            scheduleNotificationFlush();
          }
        });
      }

      if (filterInp instanceof HTMLInputElement) {
        filterInp.hidden = isAdTrackerList;
        filterInp.disabled = isAdTrackerList;
        if (!isAdTrackerList) {
          filterInp.placeholder =
            r.filterBy === 'remoteIp' || r.filterBy === 'localIp'
              ? 'e.g. 180.92.1.177, 180.92.*, 180.92.1.1-180.92.1.255, or 180.92.1.0/24 (comma-delimited)'
              : 'Comma-delimited list. Use * as wildcard, or /regex/ (case-insensitive)';
          filterInp.value = r.filter || '';
          filterInp.addEventListener('input', () => {
            r.filter = filterInp.value;
            saveHighlightRules();
            refreshTableAndArcs();
            syncAddDisabled();
          });
        }
      }

      if (filterListSel instanceof HTMLSelectElement) {
        filterListSel.hidden = !isAdTrackerList;
        filterListSel.disabled = !isAdTrackerList;
        if (isAdTrackerList) {
          fillSelect(filterListSel, AD_TRACKER_LISTS, r.filter || AD_TRACKER_LISTS[0]?.id || '');
          if (!r.filter && AD_TRACKER_LISTS[0]) {
            r.filter = AD_TRACKER_LISTS[0].id;
            saveHighlightRules();
          }
          filterListSel.addEventListener('change', () => {
            r.filter = filterListSel.value;
            saveHighlightRules();
            syncAddDisabled();
            loadAdTrackerList(r.filter).catch(() => {
              syncAddDisabled();
            });
          });
          if (r.filter) {
            loadAdTrackerList(r.filter).catch(() => {
              syncAddDisabled();
            });
          }
        }
      }

      const colorInp = card.querySelector('[data-role="rule-color"]');
      if (colorInp instanceof HTMLInputElement) {
        colorInp.value = typeof r.color === 'string' && r.color ? r.color : '#22c55e';
        colorInp.addEventListener('input', () => {
          r.color = colorInp.value;
          saveHighlightRules();
          refreshTableAndArcs();
        });
      }

      // Regex is auto-detected via /.../ in the filter string.
    });

    syncAddDisabled();
  }

  function currentArcList() {
    return Array.from(arcByKey.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([, v]) => v);
  }

  function arcColorFor(d) {
    const key = String(d.connectionKey || d.__connectionKey || '').trim();
    const now = Date.now();
    const flash = flashState.get(key);

    if (linkedHighlightKey != null && key === linkedHighlightKey) {
      const ruleStyle = key ? matchStyleByConnectionKey.get(key) : null;
      if (ruleStyle && ruleStyle.color) {
        // Hover/linked highlight should use rule color with max opacity.
        return [hexToRgba(ruleStyle.color, 1), hexToRgba(ruleStyle.color, 0.82)];
      }
      return [`rgba(0, 255, 0, 1)`, `rgba(255, 255, 0, 1)`];
    }
    const ruleStyle = key ? matchStyleByConnectionKey.get(key) : null;
    if (ruleStyle && ruleStyle.color) {
      const c1 = hexToRgba(ruleStyle.color, RULE_OPACITY);
      const c2 = hexToRgba(ruleStyle.color, Math.max(0, RULE_OPACITY - 0.22));
      return [c1, c2];
    }
    if (flash && flash.until > now) {
      if (flash.kind === 'removed') {
        return [`rgba(148, 163, 184, ${OPACITY})`, `rgba(100, 116, 139, ${OPACITY})`];
      }
      if (flash.kind === 'new') {
        const op = FLASH_NEW_OPACITY;
        return [`rgba(34, 197, 94, ${op})`, `rgba(22, 163, 74, ${op})`];
      }
    }
    return [`rgba(0, 255, 0, ${OPACITY})`, `rgba(255, 255, 0, ${OPACITY})`];
  }

  function arcStrokeFor(d) {
    const key = String(d.connectionKey || d.__connectionKey || '').trim();
    const now = Date.now();
    const flash = flashState.get(key);

    if (linkedHighlightKey != null && key === linkedHighlightKey) {
      return 0.52;
    }
    if (flash && flash.until > now) {
      if (flash.kind === 'removed') return 0.18;
      if (flash.kind === 'new') return 0.48;
    }
    return 0.25;
  }

  function syncArcStylesAndData() {
    const list = currentArcList();
    world
      .arcColor(arcColorFor)
      .arcStroke(arcStrokeFor)
      .arcsData(list)
      .arcStartLat('startLat')
      .arcStartLng('startLng')
      .arcEndLat('endLat')
      .arcEndLng('endLng');
  }

  function syncTableRowHighlight() {
    const tbody = document.getElementById('connections-tbody');
    if (!tbody) return;
    for (const tr of tbody.querySelectorAll('tr[data-connection-key]')) {
      const k = tr.getAttribute('data-connection-key') || '';
      const style = k ? matchStyleByConnectionKey.get(k) : null;
      tr.classList.toggle(
        'is-linked-highlight',
        linkedHighlightKey != null && k === linkedHighlightKey
      );
      // Provide per-row highlight color for CSS.
      if (style && style.color) tr.style.setProperty('--linked-highlight-color', style.color);
      else tr.style.removeProperty('--linked-highlight-color');
    }
  }

  function countVisibleCols(which) {
    const vis = which === 'live' ? colVisLive : colVisHist;
    const ids = which === 'live' ? LIVE_COL_IDS : HIST_COL_IDS;
    let n = 0;
    for (const id of ids) {
      if (vis[id] !== false) n += 1;
    }
    return n;
  }

  function ensureNotAllHidden(vis, ids) {
    if (ids.some((id) => vis[id] !== false)) return;
    vis.pid = true;
  }

  function saveColVis(which) {
    try {
      const key = which === 'live' ? LS_COL_VIS_LIVE : LS_COL_VIS_HISTORY;
      const obj = which === 'live' ? colVisLive : colVisHist;
      localStorage.setItem(key, JSON.stringify(obj));
    } catch {
      /* ignore */
    }
  }

  function applyColumnVisibility(which) {
    const tableId = which === 'live' ? 'live-connections-table' : 'history-connections-table';
    const vis = which === 'live' ? colVisLive : colVisHist;
    const table = document.getElementById(tableId);
    if (!table) return;
    for (const el of table.querySelectorAll('[data-col]')) {
      const col = el.getAttribute('data-col');
      if (!col || !(col in vis)) continue;
      const show = vis[col] !== false;
      el.classList.toggle('col-hidden', !show);
    }
  }

  function applyAllColumnVisibility() {
    applyColumnVisibility('live');
    applyColumnVisibility('history');
  }

  let columnPickerWhich = 'live';

  function syncChooseColumnsCheckboxes() {
    const list = document.getElementById('choose-columns-list');
    if (!list) return;
    const vis = columnPickerWhich === 'live' ? colVisLive : colVisHist;
    for (const cb of list.querySelectorAll('input[type="checkbox"][data-col]')) {
      const id = cb.getAttribute('data-col');
      if (id && id in vis) cb.checked = vis[id] !== false;
    }
  }

  function openChooseColumnsDialog(which) {
    columnPickerWhich = which;
    const dlg = document.getElementById('choose-columns-dialog');
    const sub = document.getElementById('choose-columns-subtitle');
    const list = document.getElementById('choose-columns-list');
    const title = document.getElementById('choose-columns-title');
    if (!dlg || !list || !title) return;

    title.textContent = 'Choose columns';
    if (sub) {
      sub.textContent =
        which === 'live' ? 'Live connections table' : 'History table';
    }

    const ids = which === 'live' ? LIVE_COL_IDS : HIST_COL_IDS;
    const vis = which === 'live' ? colVisLive : colVisHist;
    list.replaceChildren();

    for (const id of ids) {
      const row = document.createElement('label');
      row.className = 'choose-columns-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.setAttribute('data-col', id);
      cb.checked = vis[id] !== false;
      const span = document.createElement('span');
      span.textContent = COL_DISPLAY_LABEL[id] || id;
      row.appendChild(cb);
      row.appendChild(span);
      cb.addEventListener('change', () => {
        vis[id] = cb.checked;
        ensureNotAllHidden(vis, ids);
        saveColVis(which);
        syncChooseColumnsCheckboxes();
        applyColumnVisibility(which);
        if (which === 'live') {
          refreshTableAndArcs();
        } else {
          renderHistoryTable();
        }
      });
      list.appendChild(row);
    }

    if (typeof dlg.showModal === 'function') dlg.showModal();
  }

  function initChooseColumnsDialog() {
    const dlg = document.getElementById('choose-columns-dialog');
    const closeBtn = document.getElementById('choose-columns-close');
    const resetBtn = document.getElementById('choose-columns-reset');
    if (!dlg) return;

    closeBtn &&
      closeBtn.addEventListener('click', () => {
        if (typeof dlg.close === 'function') dlg.close();
      });

    resetBtn &&
      resetBtn.addEventListener('click', () => {
        const which = columnPickerWhich;
        const vis = which === 'live' ? colVisLive : colVisHist;
        const ids = which === 'live' ? LIVE_COL_IDS : HIST_COL_IDS;
        for (const id of ids) {
          vis[id] = true;
        }
        saveColVis(which);
        syncChooseColumnsCheckboxes();
        applyColumnVisibility(which);
        if (which === 'live') {
          refreshTableAndArcs();
        } else {
          renderHistoryTable();
        }
      });

    dlg.addEventListener('click', (e) => {
      if (e.target === dlg && typeof dlg.close === 'function') dlg.close();
    });
  }

  function parseCreateTimeMs(iso) {
    if (iso == null || iso === '') return null;
    const t = Date.parse(String(iso));
    return Number.isFinite(t) ? t : null;
  }

  function formatCreateTimeLive(iso) {
    const ms = parseCreateTimeMs(iso);
    if (ms == null) return '—';
    return new Date(ms).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function formatElapsedLive(iso) {
    const ms = parseCreateTimeMs(iso);
    if (ms == null) return '—';
    const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) {
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return `${m}m ${s}s`;
    }
    if (sec < 86400) {
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = sec % 60;
      return `${h}h ${m}m ${s}s`;
    }
    const d = Math.floor(sec / 86400);
    const rest = sec % 86400;
    const h = Math.floor(rest / 3600);
    const m = Math.floor((rest % 3600) / 60);
    const s = rest % 60;
    return `${d}d ${h}h ${m}m ${s}s`;
  }

  function syncTableHeaderSortState() {
    const thead = document.querySelector('#live-connections-table thead tr');
    if (!thead) return;
    for (const th of thead.querySelectorAll('th[data-col]')) {
      const col = th.dataset.col;
      th.classList.remove('sort-asc', 'sort-desc');
      if (col === tableSort.key) {
        th.classList.add(tableSort.dir === 'desc' ? 'sort-desc' : 'sort-asc');
        th.setAttribute('aria-sort', tableSort.dir === 'desc' ? 'descending' : 'ascending');
      } else {
        th.setAttribute('aria-sort', 'none');
      }
    }
  }

  function formatRemoteCell(c) {
    const ra = c.remoteAddress != null ? String(c.remoteAddress).trim() : '';
    if (!ra) return '—';
    const rp = c.remotePort;
    if (rp == null || Number.isNaN(Number(rp))) return '—';
    if (Number(rp) === 0) return ra;
    return `${ra}:${rp}`;
  }

  function copyableRemoteAddress(c) {
    return c.remoteAddress != null && String(c.remoteAddress).trim() !== ''
      ? String(c.remoteAddress).trim()
      : '';
  }

  function copyableRemoteHost(c) {
    const h = c.remoteHost != null ? String(c.remoteHost).trim() : '';
    return h && h !== '—' ? h : '';
  }

  let copyToastTimer = null;

  async function copyTextToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch {
        return false;
      }
    }
  }

  function showCopyToast(message) {
    const el = document.getElementById('copy-toast');
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
    el.classList.add('copy-toast-visible');
    if (copyToastTimer) clearTimeout(copyToastTimer);
    copyToastTimer = setTimeout(() => {
      el.classList.remove('copy-toast-visible');
      el.hidden = true;
      copyToastTimer = null;
    }, 2400);
  }

  function previewForToast(text) {
    const s = String(text);
    return s.length > 52 ? `${s.slice(0, 49)}…` : s;
  }

  /** Strip trailing :port from displayed local/remote cells (IPv4, hostname, or [IPv6]:port). */
  function stripAddressPort(combined) {
    const t = String(combined || '').trim();
    if (!t || t === '—') return '';
    const br = t.match(/^\[([^\]]+)\]:(\d+)$/);
    if (br) return `[${br[1]}]`;
    const lastColon = t.lastIndexOf(':');
    if (lastColon > 0) {
      const tail = t.slice(lastColon + 1);
      if (/^\d+$/.test(tail)) return t.slice(0, lastColon);
    }
    return t;
  }

  const WHOIS_DOMAINTOOLS_BASE = 'https://whois.domaintools.com/';

  function openWhoisDomaintools(query) {
    const q = String(query || '').trim();
    if (!q) return false;
    const url = `${WHOIS_DOMAINTOOLS_BASE}${encodeURIComponent(q)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
    return true;
  }

  function getCellCopyText(m, colId) {
    if (colId === 'local') {
      const raw = m.copyLocal != null ? String(m.copyLocal).trim() : '';
      if (raw) return raw;
      return stripAddressPort(m.local);
    }
    if (colId === 'remote') {
      const raw = m.copyRemote != null ? String(m.copyRemote).trim() : '';
      if (raw) return raw;
      return stripAddressPort(m.remote);
    }
    if (colId === 'remoteHost') {
      const raw = m.copyRemoteHost != null ? String(m.copyRemoteHost).trim() : '';
      if (raw) return raw;
      const h = String(m.remoteHost || '').trim();
      return h && h !== '—' ? h : '';
    }
    return '';
  }

  function wireCopyableAddressCell(td, colId, m) {
    if (colId !== 'local' && colId !== 'remote' && colId !== 'remoteHost') return;
    const text = getCellCopyText(m, colId);
    td.classList.add('cell-copyable');
    td.title = text
      ? colId === 'remoteHost'
        ? 'Click to copy · Ctrl+click to open WHOIS'
        : 'Click to copy address (without port) · Ctrl+click to open WHOIS'
      : 'Nothing to copy';
    td.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (e.ctrlKey) {
        if (!text) {
          showCopyToast('Nothing to look up');
          return;
        }
        openWhoisDomaintools(text);
        return;
      }
      if (!text) {
        showCopyToast('Nothing to copy');
        return;
      }
      const ok = await copyTextToClipboard(text);
      if (ok) showCopyToast(`Copied to clipboard: ${previewForToast(text)}`);
      else showCopyToast('Could not copy to clipboard');
    });
  }

  function connectionRowModel(c, placesByKey) {
    const p = placesByKey.get(c.connectionKey);
    const rh = c.remoteHost != null && String(c.remoteHost).trim() !== '' ? String(c.remoteHost).trim() : '—';
    const createIso = c.createTime != null && String(c.createTime).trim() !== '' ? String(c.createTime).trim() : '';
    const createTimeMs = parseCreateTimeMs(createIso || null);
    const elapsedSec =
      createTimeMs == null ? null : Math.max(0, (Date.now() - createTimeMs) / 1000);
    return {
      connectionKey: c.connectionKey,
      process: c.processName || '?',
      protocol: c.protocol != null && String(c.protocol).trim() !== '' ? String(c.protocol).trim() : 'TCP',
      local:
        c.localPort == null || Number(c.localPort) === 0
          ? String(c.localAddress || '')
          : `${c.localAddress}:${c.localPort}`,
      remote: formatRemoteCell(c),
      remoteHost: rh,
      copyLocal: String(c.localAddress || '').trim(),
      copyRemote: copyableRemoteAddress(c),
      copyRemoteHost: copyableRemoteHost(c),
      from: p ? p.start : '—',
      to: p ? p.end : '—',
      pid: c.owningPid != null ? c.owningPid : null,
      pidStr: c.owningPid != null ? String(c.owningPid) : '—',
      createTimeDisplay: formatCreateTimeLive(createIso || null),
      elapsedDisplay: formatElapsedLive(createIso || null),
      createTimeMs,
      elapsedSec,
    };
  }

  function compareConnectionModels(a, b) {
    const key = tableSort.key;
    const dir = tableSort.dir === 'desc' ? -1 : 1;
    if (key === 'pid') {
      const va = a.pid == null ? -1 : a.pid;
      const vb = b.pid == null ? -1 : b.pid;
      return dir * (va - vb);
    }
    if (key === 'createTime') {
      const va = a.createTimeMs == null ? -1 : a.createTimeMs;
      const vb = b.createTimeMs == null ? -1 : b.createTimeMs;
      return dir * (va - vb);
    }
    if (key === 'elapsed') {
      const va = a.elapsedSec == null ? -1 : a.elapsedSec;
      const vb = b.elapsedSec == null ? -1 : b.elapsedSec;
      return dir * (va - vb);
    }
    const va = String(a[key] ?? '').toLowerCase();
    const vb = String(b[key] ?? '').toLowerCase();
    return dir * va.localeCompare(vb, undefined, { numeric: true, sensitivity: 'base' });
  }

  function buildMergedArcsList(serverArcs) {
    const list = [...(serverArcs || [])];
    const keys = new Set(list.map((a) => String((a && a.connectionKey) || '')));
    const now = Date.now();
    for (const [k, f] of flashState) {
      if (f.kind === 'removed' && f.removedArc && f.until > now && !keys.has(k)) {
        list.push({ ...f.removedArc });
        keys.add(k);
      }
    }
    return list;
  }

  function buildMergedConnections() {
    const rows = [...(lastConnections || [])];
    const seen = new Set(rows.map((r) => String(r.connectionKey || '')));
    const now = Date.now();
    for (const [k, f] of flashState) {
      if (f.kind === 'removed' && f.removedConn && f.until > now && !seen.has(k)) {
        rows.push({ ...f.removedConn });
        seen.add(k);
      }
    }
    return rows;
  }

  function getLiveProtocolFilter() {
    try {
      const v = localStorage.getItem(LS_PROTOCOL_FILTER_LIVE);
      if (v === 'tcp' || v === 'udp' || v === 'both') return v;
    } catch {
      /* ignore */
    }
    return 'both';
  }

  let liveSearchQuery = '';
  /** @type {'include' | 'exclude'} */
  let liveSearchMode = 'include';

  function loadLiveSearchQuery() {
    try {
      return localStorage.getItem(LS_LIVE_SEARCH) || '';
    } catch {
      return '';
    }
  }

  function saveLiveSearchQuery(q) {
    try {
      const s = String(q || '');
      if (s) localStorage.setItem(LS_LIVE_SEARCH, s);
      else localStorage.removeItem(LS_LIVE_SEARCH);
    } catch {
      /* ignore */
    }
  }

  function loadLiveSearchMode() {
    try {
      const v = localStorage.getItem(LS_LIVE_SEARCH_MODE);
      return v === 'exclude' ? 'exclude' : 'include';
    } catch {
      return 'include';
    }
  }

  function saveLiveSearchMode(mode) {
    try {
      localStorage.setItem(LS_LIVE_SEARCH_MODE, mode === 'exclude' ? 'exclude' : 'include');
    } catch {
      /* ignore */
    }
  }

  function connectionMatchesLiveSearch(model, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return true;
    for (const col of LIVE_SEARCH_COLS) {
      const v = String(model[col] ?? '').toLowerCase();
      if (v && v !== '—' && v.includes(q)) return true;
    }
    return false;
  }

  function filterModelsByLiveSearch(models, query, mode) {
    const q = String(query || '').trim();
    if (!q) return models;
    const exclude = mode === 'exclude';
    return models.filter((m) => {
      const matches = connectionMatchesLiveSearch(m, q);
      return exclude ? !matches : matches;
    });
  }

  function getHistoryProtocolFilter() {
    try {
      const v = localStorage.getItem(LS_PROTOCOL_FILTER_HISTORY);
      if (v === 'tcp' || v === 'udp' || v === 'both') return v;
    } catch {
      /* ignore */
    }
    return 'both';
  }

  function filterConnectionsByProtocol(conns, mode) {
    return (conns || []).filter((c) => {
      const p = String(c.protocol || 'TCP').toUpperCase();
      if (mode === 'both') return true;
      if (mode === 'tcp') return p === 'TCP';
      if (mode === 'udp') return p === 'UDP';
      return true;
    });
  }

  function arcProtocolFromItem(a) {
    if (a && a.protocol != null) return String(a.protocol).toUpperCase();
    const ck = String(a.connectionKey || '');
    if (ck.startsWith('UDP|')) return 'UDP';
    return 'TCP';
  }

  function filterArcsByProtocol(arcs, mode) {
    if (mode === 'both') return arcs || [];
    return (arcs || []).filter((a) => {
      const p = arcProtocolFromItem(a);
      if (mode === 'tcp') return p === 'TCP';
      if (mode === 'udp') return p === 'UDP';
      return true;
    });
  }

  /** Count of arcs actually sent to the globe (server arcs + flash ghosts, after protocol filter). */
  function getVisibleArcCount() {
    const mergedA = buildMergedArcsList(lastArcs);
    return filterArcsByProtocol(mergedA, getLiveProtocolFilter()).length;
  }

  /** @type {'local' | 'pepwave'} */
  let currentConnectionSource = 'local';

  function updateArcCountLabel() {
    if (!countEl) return;
    const n = getVisibleArcCount();
    const noun =
      currentConnectionSource === 'pepwave' ? 'router connection' : 'connection';
    const nounPlural =
      currentConnectionSource === 'pepwave' ? 'router connections' : 'connections';
    countEl.textContent = n
      ? `Showing ${n} ${n === 1 ? noun : nounPlural}`
      : `Showing no ${nounPlural}`;
  }

  function refreshTableAndArcs() {
    const mergedA = buildMergedArcsList(lastArcs);
    const mode = getLiveProtocolFilter();
    const filteredA = filterArcsByProtocol(mergedA, mode);
    applyArcs(filteredA);
    const mergedC = buildMergedConnections();
    const filteredC = filterConnectionsByProtocol(mergedC, mode);
    const arcsByKey = new Map();
    const placesByKey = new Map();
    for (const a of filteredA || []) {
      if (a && a.connectionKey) {
        arcsByKey.set(String(a.connectionKey), a);
        placesByKey.set(String(a.connectionKey), {
          start: a.startPlace || '—',
          end: a.endPlace || '—',
        });
      }
    }
    matchStyleByConnectionKey = computeMatchStyles(filteredC, placesByKey, arcsByKey);
    renderConnectionsTable(filteredC, filteredA);
    syncTableRowHighlight();
    updateArcCountLabel();
  }

  function scheduleFlashPrune() {
    if (flashPruneTimer) clearTimeout(flashPruneTimer);
    let nextWake = Infinity;
    const now = Date.now();
    for (const [, f] of flashState) {
      if (f.until > now) nextWake = Math.min(nextWake, f.until);
    }
    if (nextWake === Infinity) {
      flashPruneTimer = null;
      return;
    }
    flashPruneTimer = setTimeout(pruneFlashState, Math.max(40, nextWake - now + 25));
  }

  function pruneFlashState() {
    flashPruneTimer = null;
    const now = Date.now();
    let changed = false;
    for (const [k, f] of flashState) {
      if (f.until <= now) {
        flashState.delete(k);
        changed = true;
      }
    }
    if (changed) {
      refreshTableAndArcs();
    }
    scheduleFlashPrune();
  }

  const TABLE_COL_DEFS = [
    { id: 'pid', mono: true, origin: false },
    { id: 'process', mono: false, origin: false },
    { id: 'protocol', mono: true, origin: false },
    { id: 'local', mono: true, origin: true },
    { id: 'remote', mono: true, origin: false },
    { id: 'remoteHost', mono: false, origin: false },
    { id: 'from', mono: false, origin: true },
    { id: 'to', mono: false, origin: false },
  ];

  const LIVE_EXTRA_COL_DEFS = [
    { id: 'createTime', mono: true, origin: false },
    { id: 'elapsed', mono: false, origin: false },
  ];

  function formatHistoryTime(ts) {
    const d = new Date(ts);
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function getHistoryMaxFromUi() {
    const inp = document.getElementById('history-max-rows');
    if (!inp) return 500;
    let n = parseInt(String(inp.value), 10);
    if (!Number.isFinite(n)) n = 500;
    return Math.max(1, Math.min(50000, n));
  }

  function trimHistory() {
    const max = getHistoryMaxFromUi();
    while (connectionHistory.length > max) {
      connectionHistory.pop();
    }
  }

  function appendHistoryEvent(kind, conn, arc) {
    if (!conn) return;
    const from = arc && arc.startPlace ? String(arc.startPlace) : '—';
    const to = arc && arc.endPlace ? String(arc.endPlace) : '—';
    const rh =
      conn.remoteHost != null && String(conn.remoteHost).trim() !== ''
        ? String(conn.remoteHost).trim()
        : '—';
    connectionHistory.unshift({
      ts: Date.now(),
      event: kind === 'disconnect' ? 'disconnect' : 'connect',
      process: conn.processName || '?',
      protocol: conn.protocol != null && String(conn.protocol).trim() !== '' ? String(conn.protocol).trim() : 'TCP',
      local: `${conn.localAddress}:${conn.localPort}`,
      remote: formatRemoteCell(conn),
      remoteHost: rh,
      copyLocal: String(conn.localAddress || '').trim(),
      copyRemote: copyableRemoteAddress(conn),
      copyRemoteHost: copyableRemoteHost(conn),
      from,
      to,
      pid: conn.owningPid != null ? conn.owningPid : null,
      pidStr: conn.owningPid != null ? String(conn.owningPid) : '—',
    });
    trimHistory();
    renderHistoryTable();
  }

  function compareHistoryModels(a, b) {
    const key = historyTableSort.key;
    const dir = historyTableSort.dir === 'desc' ? -1 : 1;
    if (key === 'time') {
      return dir * (a.ts - b.ts);
    }
    if (key === 'pid') {
      const va = a.pid == null ? -1 : a.pid;
      const vb = b.pid == null ? -1 : b.pid;
      return dir * (va - vb);
    }
    const va = String(a[key] ?? '').toLowerCase();
    const vb = String(b[key] ?? '').toLowerCase();
    return dir * va.localeCompare(vb, undefined, { numeric: true, sensitivity: 'base' });
  }

  function syncHistoryTableHeaderSortState() {
    const thead = document.querySelector('#history-connections-table thead tr');
    if (!thead) return;
    for (const th of thead.querySelectorAll('th[data-col]')) {
      const col = th.dataset.col;
      th.classList.remove('sort-asc', 'sort-desc');
      if (col === historyTableSort.key) {
        th.classList.add(historyTableSort.dir === 'desc' ? 'sort-desc' : 'sort-asc');
        th.setAttribute('aria-sort', historyTableSort.dir === 'desc' ? 'descending' : 'ascending');
      } else {
        th.setAttribute('aria-sort', 'none');
      }
    }
  }

  function renderHistoryTable() {
    const tbody = document.getElementById('history-tbody');
    if (!tbody) return;

    const rawLen = connectionHistory.length;
    let rows = filterConnectionsByProtocol([...connectionHistory], getHistoryProtocolFilter());
    rows.sort(compareHistoryModels);

    const visibleColCount = countVisibleCols('history');

    tbody.replaceChildren();

    if (rows.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = visibleColCount;
      td.className = 'connections-empty';
      td.textContent =
        rawLen === 0
          ? 'No connection events yet.'
          : 'No events match the protocol filter.';
      tr.appendChild(td);
      tbody.appendChild(tr);
      syncHistoryTableHeaderSortState();
      applyColumnVisibility('history');
      return;
    }

    function appendCell(tr, colDef, text, rowModel) {
      const td = document.createElement('td');
      td.setAttribute('data-col', colDef.id);
      if (colDef.mono) td.classList.add('mono');
      if (colDef.origin) td.classList.add('col-origin');
      td.textContent = text;
      wireCopyableAddressCell(td, colDef.id, rowModel);
      tr.appendChild(td);
    }

    for (const m of rows) {
      const tr = document.createElement('tr');

      const tdTime = document.createElement('td');
      tdTime.setAttribute('data-col', 'time');
      tdTime.classList.add('mono');
      tdTime.textContent = formatHistoryTime(m.ts);
      tr.appendChild(tdTime);

      const tdEv = document.createElement('td');
      tdEv.setAttribute('data-col', 'event');
      tdEv.textContent = m.event;
      tr.appendChild(tdEv);

      for (const col of TABLE_COL_DEFS) {
        const field = col.id === 'pid' ? 'pidStr' : col.id;
        appendCell(tr, col, m[field], m);
      }
      tbody.appendChild(tr);
    }

    syncHistoryTableHeaderSortState();
    applyColumnVisibility('history');
  }

  function initHistoryTableUi() {
    const histColsBtn = document.getElementById('history-choose-columns');
    histColsBtn && histColsBtn.addEventListener('click', () => openChooseColumnsDialog('history'));

    const maxInp = document.getElementById('history-max-rows');
    if (maxInp) {
      const saved = parseInt(localStorage.getItem(LS_HISTORY_MAX_ROWS) || '', 10);
      if (Number.isFinite(saved) && saved >= 1 && saved <= 50000) {
        maxInp.value = String(saved);
      } else {
        maxInp.value = '2000';
      }
      trimHistory();
      maxInp.addEventListener('change', () => {
        const n = getHistoryMaxFromUi();
        maxInp.value = String(n);
        localStorage.setItem(LS_HISTORY_MAX_ROWS, String(n));
        trimHistory();
        renderHistoryTable();
      });
    }

    const clearBtn = document.getElementById('history-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        connectionHistory = [];
        renderHistoryTable();
      });
    }

    const thead = document.querySelector('#history-connections-table thead');
    if (thead) {
      thead.addEventListener('click', (e) => {
        const th = e.target.closest('th[data-col]');
        if (!th) return;
        const col = th.dataset.col;
        if (historyTableSort.key === col) {
          historyTableSort.dir = historyTableSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          historyTableSort.key = col;
          historyTableSort.dir = 'asc';
        }
        localStorage.setItem(LS_HISTORY_SORT_KEY, historyTableSort.key);
        localStorage.setItem(LS_HISTORY_SORT_DIR, historyTableSort.dir);
        renderHistoryTable();
      });
      thead.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const th = e.target.closest('th[data-col]');
        if (!th) return;
        e.preventDefault();
        th.click();
      });
    }

    applyColumnVisibility('history');
    syncHistoryTableHeaderSortState();
    renderHistoryTable();
  }

  function initLiveSearch() {
    liveSearchQuery = loadLiveSearchQuery();
    liveSearchMode = loadLiveSearchMode();

    const modeSel = document.getElementById('live-search-mode');
    if (modeSel instanceof HTMLSelectElement) {
      modeSel.value = liveSearchMode;
      modeSel.addEventListener('change', () => {
        liveSearchMode = modeSel.value === 'exclude' ? 'exclude' : 'include';
        saveLiveSearchMode(liveSearchMode);
        refreshTableAndArcs();
      });
    }

    const inp = document.getElementById('live-connections-search');
    if (!(inp instanceof HTMLInputElement)) return;
    inp.value = liveSearchQuery;
    inp.addEventListener('input', () => {
      liveSearchQuery = inp.value;
      saveLiveSearchQuery(liveSearchQuery);
      refreshTableAndArcs();
    });
  }

  function initProtocolFilters() {
    const liveMode = getLiveProtocolFilter();
    const liveSel = document.getElementById('live-protocol-filter');
    if (liveSel instanceof HTMLSelectElement) {
      liveSel.value = liveMode === 'tcp' || liveMode === 'udp' || liveMode === 'both' ? liveMode : 'both';
      liveSel.addEventListener('change', () => {
        const v = liveSel.value;
        if (v !== 'tcp' && v !== 'udp' && v !== 'both') return;
        try {
          localStorage.setItem(LS_PROTOCOL_FILTER_LIVE, v);
        } catch {
          /* ignore */
        }
        refreshTableAndArcs();
      });
    }

    const histMode = getHistoryProtocolFilter();
    const histSel = document.getElementById('history-protocol-filter');
    if (histSel instanceof HTMLSelectElement) {
      histSel.value = histMode === 'tcp' || histMode === 'udp' || histMode === 'both' ? histMode : 'both';
      histSel.addEventListener('change', () => {
        const v = histSel.value;
        if (v !== 'tcp' && v !== 'udp' && v !== 'both') return;
        try {
          localStorage.setItem(LS_PROTOCOL_FILTER_HISTORY, v);
        } catch {
          /* ignore */
        }
        renderHistoryTable();
      });
    }
  }

  function initPanelTabs() {
    const liveTab = document.getElementById('tab-live');
    const histTab = document.getElementById('tab-history');
    const rulesTab = document.getElementById('tab-highlight-rules');
    const settingsTab = document.getElementById('tab-settings');
    const livePanel = document.getElementById('panel-live');
    const histPanel = document.getElementById('panel-history');
    const rulesPanel = document.getElementById('panel-highlight-rules');
    const settingsPanel = document.getElementById('panel-settings');
    if (
      !liveTab ||
      !histTab ||
      !rulesTab ||
      !settingsTab ||
      !livePanel ||
      !histPanel ||
      !rulesPanel ||
      !settingsPanel
    ) {
      return;
    }

    function normalizeTab(which) {
      if (which === 'settings') return 'settings';
      if (which === 'highlight-rules' || which === 'rules') return 'highlight-rules';
      if (which === 'history') return 'history';
      return 'live';
    }

    function selectTab(which) {
      const w = normalizeTab(which);
      const isLive = w === 'live';
      const isHist = w === 'history';
      const isRules = w === 'highlight-rules';
      const isSettings = w === 'settings';

      liveTab.setAttribute('aria-selected', isLive ? 'true' : 'false');
      histTab.setAttribute('aria-selected', isHist ? 'true' : 'false');
      rulesTab.setAttribute('aria-selected', isRules ? 'true' : 'false');
      settingsTab.setAttribute('aria-selected', isSettings ? 'true' : 'false');
      liveTab.tabIndex = isLive ? 0 : -1;
      histTab.tabIndex = isHist ? 0 : -1;
      rulesTab.tabIndex = isRules ? 0 : -1;
      settingsTab.tabIndex = isSettings ? 0 : -1;
      livePanel.hidden = !isLive;
      histPanel.hidden = !isHist;
      rulesPanel.hidden = !isRules;
      settingsPanel.hidden = !isSettings;
      try {
        localStorage.setItem(LS_DRAWER_TAB, w);
      } catch {
        /* ignore */
      }
      if (isRules) {
        syncRuleSetsUi();
        renderSettingsRules();
      }
    }

    liveTab.addEventListener('click', () => selectTab('live'));
    histTab.addEventListener('click', () => selectTab('history'));
    rulesTab.addEventListener('click', () => selectTab('highlight-rules'));
    settingsTab.addEventListener('click', () => selectTab('settings'));

    const saved = localStorage.getItem(LS_DRAWER_TAB);
    selectTab(saved || 'live');
  }

  function initConnectionsTableUi() {
    const liveColsBtn = document.getElementById('live-choose-columns');
    liveColsBtn && liveColsBtn.addEventListener('click', () => openChooseColumnsDialog('live'));

    const thead = document.querySelector('#live-connections-table thead');
    if (thead) {
      thead.addEventListener('click', (e) => {
        const th = e.target.closest('th[data-col]');
        if (!th) return;
        const col = th.dataset.col;
        if (tableSort.key === col) {
          tableSort.dir = tableSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          tableSort.key = col;
          tableSort.dir = 'asc';
        }
        localStorage.setItem(LS_SORT_KEY, tableSort.key);
        localStorage.setItem(LS_SORT_DIR, tableSort.dir);
        refreshTableAndArcs();
      });
      thead.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const th = e.target.closest('th[data-col]');
        if (!th) return;
        e.preventDefault();
        th.click();
      });
    }

    applyColumnVisibility('live');
    syncTableHeaderSortState();
  }

  function setLinkedHighlight(key) {
    linkedHighlightKey = key != null && key !== '' ? String(key) : null;
    syncArcStylesAndData();
    syncTableRowHighlight();
  }

  function clearLinkedHighlightIf(key) {
    const k = key != null ? String(key) : '';
    if (linkedHighlightKey === k) setLinkedHighlight(null);
  }

  world.onArcHover((arc) => {
    if (!arc) {
      setLinkedHighlight(null);
      return;
    }
    const key = arc.connectionKey || arc.__connectionKey;
    setLinkedHighlight(key != null ? String(key) : null);
  });

  function stableConnectionKey(arc) {
    if (arc && typeof arc.connectionKey === 'string' && arc.connectionKey.length) {
      return arc.connectionKey;
    }
    if (arc && typeof arc.label === 'string' && arc.label.length) return arc.label;
    return ['startLat', 'startLng', 'endLat', 'endLng']
      .map((k) => arc[k])
      .join('|');
  }

  function applyArcs(incoming) {
    const next = Array.isArray(incoming) ? incoming : [];
    const nextKeys = new Set();

    for (const item of next) {
      const key = stableConnectionKey(item);
      nextKeys.add(key);
      let arc = arcByKey.get(key);
      if (arc) {
        arc.startLat = item.startLat;
        arc.startLng = item.startLng;
        arc.endLat = item.endLat;
        arc.endLng = item.endLng;
        if (item.connectionKey != null) arc.connectionKey = item.connectionKey;
        if (item.label != null) arc.label = item.label;
        if (item.remoteCountry != null) arc.remoteCountry = item.remoteCountry;
        if (item.startPlace != null) arc.startPlace = item.startPlace;
        if (item.endPlace != null) arc.endPlace = item.endPlace;
        if (item.protocol != null) arc.protocol = item.protocol;
      } else {
        arc = {
          __connectionKey: key,
          connectionKey: item.connectionKey || key,
          startLat: item.startLat,
          startLng: item.startLng,
          endLat: item.endLat,
          endLng: item.endLng,
          label: item.label,
          remoteCountry: item.remoteCountry,
          startPlace: item.startPlace,
          endPlace: item.endPlace,
          protocol: item.protocol,
        };
        arcByKey.set(key, arc);
      }
    }

    for (const key of arcByKey.keys()) {
      if (!nextKeys.has(key)) arcByKey.delete(key);
    }

    if (linkedHighlightKey != null && !arcByKey.has(linkedHighlightKey)) {
      linkedHighlightKey = null;
    }

    syncArcStylesAndData();
    syncTableRowHighlight();
  }

  function setError(msg) {
    if (msg) {
      errorEl.hidden = false;
      errorEl.textContent = msg;
    } else {
      errorEl.hidden = true;
      errorEl.textContent = '';
    }
  }

  function renderConnectionsTable(connections, arcs) {
    const tbody = document.getElementById('connections-tbody');
    if (!tbody) return;

    const placesByKey = new Map();
    for (const a of arcs || []) {
      if (a && a.connectionKey) {
        placesByKey.set(a.connectionKey, {
          start: a.startPlace || '—',
          end: a.endPlace || '—',
        });
      }
    }

    const allModels = (connections || []).map((c) => connectionRowModel(c, placesByKey));
    allModels.sort(compareConnectionModels);
    const searchQ = String(liveSearchQuery || '').trim();
    const models = filterModelsByLiveSearch(allModels, searchQ, liveSearchMode);

    const visibleColCount = countVisibleCols('live') + 1;

    tbody.replaceChildren();

    if (allModels.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = visibleColCount;
      td.className = 'connections-empty';
      td.textContent = 'No connections.';
      tr.appendChild(td);
      tbody.appendChild(tr);
      syncTableHeaderSortState();
      applyColumnVisibility('live');
      return;
    }

    if (models.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = visibleColCount;
      td.className = 'connections-empty';
      td.textContent =
        liveSearchMode === 'exclude'
          ? 'No connections to show (all rows excluded by search).'
          : 'No connections match your search.';
      tr.appendChild(td);
      tbody.appendChild(tr);
      syncTableHeaderSortState();
      applyColumnVisibility('live');
      return;
    }

    function appendCell(tr, colDef, text, copyModel) {
      const td = document.createElement('td');
      td.setAttribute('data-col', colDef.id);
      if (colDef.mono) td.classList.add('mono');
      if (colDef.origin) td.classList.add('col-origin');
      td.textContent = text;
      wireCopyableAddressCell(td, colDef.id, copyModel);
      tr.appendChild(td);
    }

    const nowMs = Date.now();

    for (const m of models) {
      const tr = document.createElement('tr');
      const ck = m.connectionKey != null ? String(m.connectionKey) : '';
      if (ck) tr.setAttribute('data-connection-key', ck);

      const tdDot = document.createElement('td');
      tdDot.className = 'col-rule-dot';
      const dot = document.createElement('span');
      dot.className = 'rule-dot';
      const style = ck ? matchStyleByConnectionKey.get(ck) : null;
      if (style && style.color) {
        dot.classList.add('rule-dot-active');
        dot.style.background = style.color;
        const tip = style.ruleLabel ? String(style.ruleLabel) : '';
        if (tip) {
          dot.title = tip;
          tdDot.title = tip;
        }
      }
      tdDot.appendChild(dot);
      tr.appendChild(tdDot);

      const fk = ck ? flashState.get(ck) : null;
      if (fk && fk.until > nowMs) {
        if (fk.kind === 'new') tr.classList.add('row-flash-new');
        if (fk.kind === 'removed') tr.classList.add('row-flash-removed');
      }

      for (const col of TABLE_COL_DEFS) {
        const field = col.id === 'pid' ? 'pidStr' : col.id;
        appendCell(tr, col, m[field], m);
      }
      for (const col of LIVE_EXTRA_COL_DEFS) {
        const text = col.id === 'createTime' ? m.createTimeDisplay : m.elapsedDisplay;
        appendCell(tr, col, text, m);
      }
      tbody.appendChild(tr);

      if (ck) {
        tr.addEventListener('mouseenter', () => setLinkedHighlight(ck));
        tr.addEventListener('mouseleave', () => clearLinkedHighlightIf(ck));
      }
    }

    syncTableHeaderSortState();
    applyColumnVisibility('live');
    syncTableRowHighlight();
  }

  function handlePayload(data) {
    if (data.connectionSource === 'pepwave' || data.connectionSource === 'local') {
      currentConnectionSource = data.connectionSource;
    }

    if (data.connectionSource === 'pepwave') {
      if (data.error) {
        setPepwaveSettingsStatus(String(data.error));
      } else {
        setPepwaveSettingsStatus('');
      }
    } else if (getConnectionSourceFromUi() !== 'pepwave') {
      setPepwaveSettingsStatus('');
    }

    if (data.error) {
      setError(data.error);
      flashState.clear();
      if (flashPruneTimer) {
        clearTimeout(flashPruneTimer);
        flashPruneTimer = null;
      }
      lastConnections = data.connections || [];
      lastArcs = data.arcs || [];
      refreshTableAndArcs();
      statusEl.textContent = data.updatedAt
        ? `Updated ${new Date(data.updatedAt).toLocaleTimeString()}`
        : 'Live';
      return;
    }
    setError('');

    const prevConn = lastConnections || [];
    const prevKeys = new Set(prevConn.map((c) => String(c.connectionKey || '')));
    const nextConn = data.connections || [];
    const nextArcs = data.arcs || [];
    const nextKeys = new Set(nextConn.map((c) => String(c.connectionKey || '')));
    const until = Date.now() + FLASH_MS;
    const isInitial = prevKeys.size === 0 && prevConn.length === 0;

    if (!isInitial) {
      const arcByKeyNext = new Map();
      for (const a of nextArcs) {
        if (a && a.connectionKey != null) arcByKeyNext.set(String(a.connectionKey), a);
      }
      const placesByKeyNext = new Map();
      for (const [k, a] of arcByKeyNext) {
        placesByKeyNext.set(k, { start: a.startPlace || '—', end: a.endPlace || '—' });
      }

      for (const k of nextKeys) {
        if (!prevKeys.has(k)) {
          flashState.set(k, { kind: 'new', until });
          const conn = nextConn.find((c) => String(c.connectionKey) === k);
          if (conn) {
            appendHistoryEvent('connect', { ...conn }, arcByKeyNext.get(k) || null);
            maybeNotifyForConnection(conn, placesByKeyNext, arcByKeyNext);
          }
        }
      }
      for (const k of prevKeys) {
        if (!nextKeys.has(k)) {
          const conn = prevConn.find((c) => String(c.connectionKey) === k);
          const pa = lastArcs || [];
          const arc = pa.find((a) => a && String(a.connectionKey) === k);
          const isUdp = conn && String(conn.protocol || '').toUpperCase() === 'UDP';
          if (conn && (arc || isUdp)) {
            if (arc) {
              flashState.set(k, {
                kind: 'removed',
                until,
                removedConn: { ...conn },
                removedArc: { ...arc },
              });
            } else {
              flashState.set(k, {
                kind: 'removed',
                until,
                removedConn: { ...conn },
              });
            }
            appendHistoryEvent('disconnect', { ...conn }, arc ? { ...arc } : null);
          }
        }
      }
    }

    lastConnections = nextConn;
    lastArcs = nextArcs;

    refreshTableAndArcs();
    scheduleFlashPrune();

    statusEl.textContent = data.updatedAt
      ? `Updated ${new Date(data.updatedAt).toLocaleTimeString()}`
      : 'Live';
  }

  function applyPollIntervalFromServer(ms) {
    const n = Number(ms);
    if (!POLL_MS_OPTIONS.includes(n)) return;
    const sel = document.getElementById('poll-interval');
    if (sel) sel.value = String(n);
    localStorage.setItem(LS_POLL_MS, String(n));
  }

  function loadPepwaveConfig() {
    try {
      const raw = localStorage.getItem(LS_PEPWAVE_CONFIG);
      if (!raw) return { host: '', username: '', password: '', sshPort: 8822 };
      const o = JSON.parse(raw);
      let sshPort = o && o.sshPort != null ? Number(o.sshPort) : 8822;
      if (!Number.isFinite(sshPort) || sshPort <= 0) sshPort = 8822;
      return {
        host: o && o.host != null ? String(o.host) : '',
        username: o && o.username != null ? String(o.username) : '',
        password: o && o.password != null ? String(o.password) : '',
        sshPort,
      };
    } catch {
      return { host: '', username: '', password: '', sshPort: 8822 };
    }
  }

  function savePepwaveConfig(cfg) {
    try {
      localStorage.setItem(LS_PEPWAVE_CONFIG, JSON.stringify(cfg));
    } catch {
      /* ignore */
    }
  }

  function getConnectionSourceFromUi() {
    const sel = document.getElementById('connection-source');
    const v = sel instanceof HTMLSelectElement ? sel.value : 'local';
    return v === 'pepwave' ? 'pepwave' : 'local';
  }

  function readPepwaveConfigFromUi() {
    const hostEl = document.getElementById('pepwave-host');
    const userEl = document.getElementById('pepwave-username');
    const passEl = document.getElementById('pepwave-password');
    const portEl = document.getElementById('pepwave-ssh-port');
    let sshPort = portEl instanceof HTMLInputElement ? Number(portEl.value) : 8822;
    if (!Number.isFinite(sshPort) || sshPort <= 0) sshPort = 8822;
    return {
      host: hostEl instanceof HTMLInputElement ? hostEl.value.trim() : '',
      username: userEl instanceof HTMLInputElement ? userEl.value : '',
      password: passEl instanceof HTMLInputElement ? passEl.value : '',
      sshPort,
    };
  }

  function setPepwaveSettingsStatus(text) {
    const el = document.getElementById('pepwave-settings-status');
    if (!el) return;
    if (!text) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.hidden = false;
    el.textContent = text;
  }

  function syncPepwavePanelVisibility() {
    const panel = document.getElementById('pepwave-settings');
    const source = getConnectionSourceFromUi();
    if (panel) panel.hidden = source !== 'pepwave';
    if (source !== 'pepwave') setPepwaveSettingsStatus('');
  }

  function sendConnectionSourceToServer() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const source = getConnectionSourceFromUi();
    const payload = { type: 'setConnectionSource', source };
    if (source === 'pepwave') {
      const cfg = readPepwaveConfigFromUi();
      savePepwaveConfig(cfg);
      payload.pepwave = cfg;
      if (!cfg.host || !cfg.username) {
        setPepwaveSettingsStatus('Enter router address and username to connect.');
        return;
      }
      setPepwaveSettingsStatus('Connecting to Pepwave router…');
    }
    currentConnectionSource = source === 'pepwave' ? 'pepwave' : 'local';
    updateArcCountLabel();
    ws.send(JSON.stringify(payload));
  }

  function initConnectionSourceControl() {
    const sel = document.getElementById('connection-source');
    if (!(sel instanceof HTMLSelectElement)) return;

    try {
      const saved = localStorage.getItem(LS_CONNECTION_SOURCE);
      if (saved === 'pepwave' || saved === 'local') sel.value = saved;
    } catch {
      /* ignore */
    }

    const cfg = loadPepwaveConfig();
    const hostEl = document.getElementById('pepwave-host');
    const userEl = document.getElementById('pepwave-username');
    const passEl = document.getElementById('pepwave-password');
    const portEl = document.getElementById('pepwave-ssh-port');
    if (hostEl instanceof HTMLInputElement) hostEl.value = cfg.host;
    if (userEl instanceof HTMLInputElement) userEl.value = cfg.username;
    if (passEl instanceof HTMLInputElement) passEl.value = cfg.password;
    if (portEl instanceof HTMLInputElement) portEl.value = String(cfg.sshPort || 8822);

    syncPepwavePanelVisibility();
    currentConnectionSource = getConnectionSourceFromUi() === 'pepwave' ? 'pepwave' : 'local';
    updateArcCountLabel();

    const push = () => {
      try {
        localStorage.setItem(LS_CONNECTION_SOURCE, getConnectionSourceFromUi());
      } catch {
        /* ignore */
      }
      syncPepwavePanelVisibility();
      sendConnectionSourceToServer();
    };

    let pepwavePushTimer = null;
    const schedulePush = () => {
      if (pepwavePushTimer) clearTimeout(pepwavePushTimer);
      pepwavePushTimer = setTimeout(() => {
        pepwavePushTimer = null;
        push();
      }, 500);
    };

    sel.addEventListener('change', push);
    for (const id of ['pepwave-host', 'pepwave-username', 'pepwave-password', 'pepwave-ssh-port']) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.addEventListener('change', push);
      if (el instanceof HTMLInputElement && (el.type === 'text' || el.type === 'password')) {
        el.addEventListener('input', () => {
          savePepwaveConfig(readPepwaveConfigFromUi());
          if (getConnectionSourceFromUi() === 'pepwave') schedulePush();
        });
      }
    }
  }

  function initGlobeThemeControl() {
    const sel = document.getElementById('globe-theme');
    if (!sel) return;
    const theme = loadGlobeTheme();
    sel.value = theme;
    sel.addEventListener('change', () => {
      const next = normalizeGlobeTheme(sel.value);
      saveGlobeTheme(next);
      syncGlobeAppearance(next);
    });
  }

  function initGlobeCloudsControl() {
    const cb = document.getElementById('globe-clouds');
    if (!(cb instanceof HTMLInputElement)) return;
    cb.checked = globeCloudsEnabled;
    cb.addEventListener('change', () => {
      setCloudsEnabled(cb.checked);
    });
    if (globeCloudsEnabled) {
      setCloudsEnabled(true);
    }
  }

  function initPollIntervalControl() {
    const sel = document.getElementById('poll-interval');
    if (!sel) return;
    const saved = localStorage.getItem(LS_POLL_MS);
    if (saved && POLL_MS_OPTIONS.includes(Number(saved))) {
      sel.value = saved;
    }
    sel.addEventListener('change', () => {
      const ms = Number(sel.value);
      if (!POLL_MS_OPTIONS.includes(ms)) return;
      localStorage.setItem(LS_POLL_MS, String(ms));
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'setPollMs', ms }));
      }
    });
  }

  let ws;
  function connect() {
    ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      statusEl.textContent = 'Live';
      const saved = localStorage.getItem(LS_POLL_MS);
      if (saved && POLL_MS_OPTIONS.includes(Number(saved))) {
        ws.send(JSON.stringify({ type: 'setPollMs', ms: Number(saved) }));
      }
      sendConnectionSourceToServer();
    };
    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data && data.type === 'config') {
          if (data.pollMs != null) applyPollIntervalFromServer(data.pollMs);
          if (data.connectionSource === 'pepwave' || data.connectionSource === 'local') {
            currentConnectionSource = data.connectionSource;
            updateArcCountLabel();
          }
          return;
        }
        handlePayload(data);
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      statusEl.textContent = 'Reconnecting…';
      setTimeout(connect, 2000);
    };
    ws.onerror = () => {
      statusEl.textContent = 'Connection error';
    };
  }

  initGlobeThemeControl();
  initGlobeCloudsControl();
  initPollIntervalControl();
  initConnectionSourceControl();
  initConnectionsTableUi();
  initHistoryTableUi();
  ruleSetsState = loadRuleSetsState();
  applyHighlightRulesFromState();
  preloadAdTrackerListsForRules(highlightRules);
  initRuleSetsUi();
  const addRuleBtn = document.getElementById('settings-add-rule');
  if (addRuleBtn) {
    addRuleBtn.addEventListener('click', () => {
      if (highlightRules.length > 0) {
        const last = highlightRules[highlightRules.length - 1];
        if (!isRuleFilled(last)) return;
      }
      highlightRules.push(defaultRule());
      saveHighlightRules();
      renderSettingsRules();
      refreshTableAndArcs();
    });
  }
  initPanelTabs();
  initChooseColumnsDialog();
  initProtocolFilters();
  initLiveSearch();
  applyAllColumnVisibility();
  connect();

  const drawer = document.getElementById('drawer');
  const drawerTab = document.getElementById('drawer-tab');
  const drawerClose = document.getElementById('drawer-close');
  const drawerPanel = document.getElementById('drawer-panel');

  const DRAWER_W_MIN = 500;
  const DRAWER_W_MAX = 1400;
  const DRAWER_W_STORAGE = 'netstatGlobeDrawerWidth';
  /** Minimum width (px) reserved for the globe beside the drawer (panel + tab). */
  const GLOBE_AREA_MIN_PX = 330;

  function getDrawerTabWidthPx() {
    const tab = document.getElementById('drawer-tab');
    return tab ? tab.getBoundingClientRect().width : 36;
  }

  function maxDrawerPanelWidthPx() {
    const shell = document.querySelector('.app-shell');
    const vw = shell ? shell.clientWidth : window.innerWidth;
    const tabW = getDrawerTabWidthPx();
    const maxPanel = vw - GLOBE_AREA_MIN_PX - tabW - 1;
    return Math.max(0, Math.min(DRAWER_W_MAX, Math.floor(maxPanel)));
  }

  function clampDrawerWidth(px) {
    const maxAllowed = maxDrawerPanelWidthPx();
    const minAllowed = Math.min(DRAWER_W_MIN, maxAllowed);
    const w = Math.round(px);
    return Math.min(DRAWER_W_MAX, maxAllowed, Math.max(minAllowed, w));
  }

  function getDrawerPanelWidthCssPx() {
    if (!drawer) return 420;
    const raw = drawer.style.getPropertyValue('--drawer-width').trim();
    let v = parseFloat(raw);
    if (Number.isFinite(v)) return v;
    const cs = getComputedStyle(drawer).getPropertyValue('--drawer-width').trim();
    v = parseFloat(cs);
    return Number.isFinite(v) ? v : 420;
  }

  function enforceDrawerWithinGlobeLimit() {
    if (!drawer || drawer.dataset.open !== 'true') return;
    const maxW = maxDrawerPanelWidthPx();
    const current = getDrawerPanelWidthCssPx();
    if (current <= maxW) return;
    drawer.style.setProperty('--drawer-width', `${maxW}px`);
    try {
      localStorage.setItem(DRAWER_W_STORAGE, String(Math.round(maxW)));
    } catch {
      /* ignore */
    }
    layoutGlobe();
  }

  if (drawer) {
    const saved = parseInt(localStorage.getItem(DRAWER_W_STORAGE), 10);
    if (Number.isFinite(saved)) {
      drawer.style.setProperty('--drawer-width', `${clampDrawerWidth(saved)}px`);
    }

    function setDrawerOpen(open) {
      drawer.dataset.open = open ? 'true' : 'false';
      if (drawerTab) {
        drawerTab.setAttribute('aria-expanded', open ? 'true' : 'false');
        drawerTab.title = open ? 'Hide connections' : 'Show connections';
      }
      requestAnimationFrame(() => {
        enforceDrawerWithinGlobeLimit();
        layoutGlobe();
        requestAnimationFrame(layoutGlobe);
      });
    }

    drawerTab &&
      drawerTab.addEventListener('click', () => {
        setDrawerOpen(drawer.dataset.open !== 'true');
      });
    drawerClose &&
      drawerClose.addEventListener('click', () => {
        setDrawerOpen(false);
      });

    const resizeEl = drawer.querySelector('.drawer-resize');
    if (resizeEl && drawerPanel) {
      resizeEl.addEventListener('mousedown', (e) => {
        if (drawer.dataset.open !== 'true') return;
        e.preventDefault();
        drawer.dataset.resizing = 'true';
        const startX = e.clientX;
        const startW = drawerPanel.getBoundingClientRect().width;

        function onMove(e2) {
          const dx = startX - e2.clientX;
          const next = clampDrawerWidth(startW + dx);
          drawer.style.setProperty('--drawer-width', `${next}px`);
          layoutGlobe();
        }

        function onUp() {
          drawer.dataset.resizing = 'false';
          const w = drawerPanel.getBoundingClientRect().width;
          localStorage.setItem(DRAWER_W_STORAGE, String(Math.round(w)));
          layoutGlobe();
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        }

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    }
  }

  window.addEventListener('resize', () => {
    enforceDrawerWithinGlobeLimit();
    layoutGlobe();
  });

  if (globeStage && typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => layoutGlobe());
    ro.observe(globeStage);
  }

  layoutGlobe();

  world.pointOfView(loadSavedPov() || DEFAULT_POV, 0);
  if (
    currentGlobeTheme === GLOBE_THEME_REALTIME ||
    currentGlobeTheme === GLOBE_THEME_BOUNDARIES
  ) {
    syncGlobeAppearance(currentGlobeTheme);
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      povPersistenceReady = true;
    });
  });
})();
