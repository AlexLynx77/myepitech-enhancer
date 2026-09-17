/**
 * MyEpitech Enhancer - Bridge (world: MAIN)
 * S'exécute dans le contexte JavaScript principal de la page afin d'accéder
 * directement à l'arbre React et au contexte API (apiContext) de MyEpitech.
 */
(() => {
  if (window.__MYEPITECH_BRIDGE_LOADED__) return;
  window.__MYEPITECH_BRIDGE_LOADED__ = true;

  console.log('[MyEpitech Bridge] Initialisé dans le monde principal');

  /**
   * Recherche l'instance apiContext dans l'arbre React
   */
  function findApiContext() {
    const candidates = [
      document.querySelector('#root'),
      document.body,
      ...Array.from(document.querySelectorAll('div')).slice(0, 100)
    ];

    for (const el of candidates) {
      if (!el) continue;
      const k = Object.keys(el).find((key) => key.startsWith('__reactFiber'));
      if (!k) continue;

      let f = el[k];
      let depth = 0;
      while (f && depth < 30) {
        if (f.memoizedProps && f.memoizedProps.value && f.memoizedProps.value.units) {
          return f.memoizedProps.value;
        }
        f = f.return;
        depth++;
      }
    }
    return null;
  }

  /**
   * Récupère la liste officielle des modules inscrits via l'API interne MyEpitech
   */
  async function fetchEnrolledModules(schoolYear) {
    const year = Number(schoolYear) || 2026;
    let apiContext = findApiContext();

    // Réessayer brièvement si l'arbre React est encore en cours d'hydratation
    if (!apiContext || !apiContext.units) {
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 250));
        apiContext = findApiContext();
        if (apiContext && apiContext.units) break;
      }
    }

    if (!apiContext || !apiContext.units || typeof apiContext.units.getAllUnitInstances !== 'function') {
      console.warn('[MyEpitech Bridge] apiContext.units non disponible');
      return null;
    }

    try {
      const res = await apiContext.units.getAllUnitInstances({ schoolYear: year, expanded: false });
      const items = (res && res.data) ? res.data : [];
      const registeredCodes = items
        .filter((u) => Boolean(u.isRegistered))
        .map((u) => String(u.unitCode || u.code || '').toUpperCase().trim())
        .filter((code) => Boolean(code) && !/^[A-Z]{2,4}-[0-9]+$/i.test(code));

      const now = new Date();
      const unitsDetails = {};
      items.forEach((u) => {
        const code = String(u.unitCode || u.code || '').toUpperCase().trim();
        if (!code) return;
        const isReg = Boolean(u.isRegistered);
        let isOpen = false;

        const startDate = u.startDate ? new Date(u.startDate) : null;
        const endDate = u.endRegistrationDate
          ? new Date(u.endRegistrationDate)
          : (u.endDate ? new Date(u.endDate) : null);

        // Ouvert uniquement si la date courante est comprise entre la date de début et de fin d'inscription
        if ((!startDate || now >= startDate) && (!endDate || now <= endDate)) {
          isOpen = true;
        }

        unitsDetails[code] = {
          isRegistered: isReg,
          isOpen: isOpen,
          startDate: u.startDate,
          endRegistrationDate: u.endRegistrationDate,
          endDate: u.endDate,
          name: u.name
        };
      });

      return {
        schoolYear: String(year),
        registeredCodes: Array.from(new Set(registeredCodes)),
        unitsDetails: unitsDetails
      };
    } catch (err) {
      console.error('[MyEpitech Bridge] Erreur lors de la récupération des modules :', err);
      return null;
    }
  }

  /**
   * Recherche les données académiques directement dans l'arbre React Fiber
   */
  function findAcademicDataFromFiber() {
    const candidates = [
      document.querySelector('#root'),
      ...Array.from(document.querySelectorAll('[class*="Tabs"], [class*="mantine"], div')).slice(0, 120)
    ];

    for (const el of candidates) {
      if (!el) continue;
      const k = Object.keys(el).find((key) => key.startsWith('__reactFiber'));
      if (!k) continue;

      let f = el[k];
      let depth = 0;
      while (f && depth < 40) {
        if (f.memoizedProps) {
          if (Array.isArray(f.memoizedProps.blocks) && f.memoizedProps.blocks.length > 0) {
            return f.memoizedProps;
          }
          if (f.memoizedProps.data && Array.isArray(f.memoizedProps.data.blocks)) {
            return f.memoizedProps.data;
          }
        }
        let s = f.memoizedState;
        let sDepth = 0;
        while (s && sDepth < 10) {
          if (s.memoizedState) {
            if (Array.isArray(s.memoizedState.blocks) && s.memoizedState.blocks.length > 0) {
              return s.memoizedState;
            }
            if (s.memoizedState.data && Array.isArray(s.memoizedState.data.blocks)) {
              return s.memoizedState.data;
            }
          }
          s = s.next;
          sDepth++;
        }
        f = f.return;
        depth++;
      }
    }
    return null;
  }

  /**
   * Récupère les en-têtes d'authentification disponibles
   */
  function getAuthHeader() {
    // 1. Clé spécifique MyEpitech (@account)
    try {
      const accountRaw = localStorage.getItem('@account');
      if (accountRaw) {
        const account = JSON.parse(accountRaw);
        if (account && account.token) {
          const t = account.token;
          return { 'Authorization': t.startsWith('Bearer ') ? t : `Bearer ${t}` };
        }
      }
    } catch (e) {}

    for (const key of ['token', 'access_token', 'jwt', 'authToken', 'office_token']) {
      const val = localStorage.getItem(key) || sessionStorage.getItem(key);
      if (val && typeof val === 'string' && val.length > 20) {
        return { 'Authorization': val.startsWith('Bearer ') ? val : `Bearer ${val}` };
      }
    }
    const api = findApiContext();
    if (api && api.client && api.client.defaults && api.client.defaults.headers) {
      const h = api.client.defaults.headers.common || api.client.defaults.headers;
      if (h && (h.Authorization || h.authorization)) {
        return { 'Authorization': h.Authorization || h.authorization };
      }
    }
    return {};
  }

  const academicDataCacheMap = new Map();

  /**
   * Récupère le parcours académique, les validations et le profil GPA en parallèle
   */
  async function fetchAcademicData(semesterId, forceRefresh = false) {
    const cacheKey = semesterId ? String(semesterId) : 'default';
    if (!forceRefresh && academicDataCacheMap.has(cacheKey)) {
      return academicDataCacheMap.get(cacheKey);
    }

    let apiContext = findApiContext();
    if (!apiContext || !apiContext.evaluations) {
      for (let i = 0; i < 4; i++) {
        await new Promise((r) => setTimeout(r, 150));
        apiContext = findApiContext();
        if (apiContext && apiContext.evaluations) break;
      }
    }

    let validationsData = null;
    let creditsData = null;
    let userData = null;
    let profileData = null;

    if (apiContext) {
      const params = semesterId ? { semesterId: Number(semesterId) } : {};

      const validationsPromise = (async () => {
        try {
          if (apiContext.evaluations && typeof apiContext.evaluations.getMyValidations === 'function') {
            const res = await apiContext.evaluations.getMyValidations(params);
            return (res && res.data) ? res.data : res;
          }
        } catch (e) {
          console.warn('[MyEpitech Bridge] Erreur getMyValidations :', e);
        }
        return null;
      })();

      const creditsPromise = (async () => {
        try {
          if (apiContext.evaluations && typeof apiContext.evaluations.getMyCredits === 'function') {
            const res = await apiContext.evaluations.getMyCredits();
            return (res && res.data) ? res.data : res;
          }
        } catch (e) {
          console.warn('[MyEpitech Bridge] Erreur getMyCredits :', e);
        }
        return null;
      })();

      const userPromise = (async () => {
        try {
          if (apiContext.api && typeof apiContext.api.getUserInfos === 'function') {
            const res = await apiContext.api.getUserInfos();
            return (res && res.data) ? res.data : (res || apiContext.user || null);
          }
        } catch (e) {
          console.warn('[MyEpitech Bridge] Erreur getUserInfos :', e);
        }
        return apiContext.user || null;
      })();

      const profilePromise = (async () => {
        try {
          if (apiContext.students) {
            if (typeof apiContext.students.getProfile === 'function') {
              const res = await apiContext.students.getProfile();
              return (res && res.data) ? res.data : res;
            }
            if (typeof apiContext.students.getStudentProfile === 'function') {
              const res = await apiContext.students.getStudentProfile();
              return (res && res.data) ? res.data : res;
            }
          }
        } catch (e) {
          console.warn('[MyEpitech Bridge] Erreur getProfile/getStudentProfile :', e);
        }
        return null;
      })();

      const [valRes, credRes, userRes, profRes] = await Promise.all([
        validationsPromise,
        creditsPromise,
        userPromise,
        profilePromise
      ]);

      validationsData = valRes;
      creditsData = credRes;
      userData = userRes;
      profileData = profRes;
    }

    // Fallback supplémentaire depuis React Fiber si nécessaire
    if (!validationsData || !validationsData.blocks) {
      validationsData = findAcademicDataFromFiber();
    }

    // Fallback HTTP avec token si disponible
    if (!validationsData || !validationsData.blocks) {
      const headers = { 'Accept': 'application/json', ...getAuthHeader() };
      const q = semesterId ? `?semesterId=${semesterId}` : '';
      for (const endpoint of [`/api/evaluations/validations/me${q}`, `/evaluations/validations/me${q}`]) {
        try {
          const r = await fetch(endpoint, { headers, credentials: 'include' });
          if (r.ok) {
            validationsData = await r.json();
            break;
          }
        } catch (e) {}
      }
    }

    const finalResult = {
      validations: validationsData,
      credits: creditsData,
      user: userData,
      profile: profileData,
      timestamp: Date.now()
    };

    if (validationsData && validationsData.blocks) {
      academicDataCacheMap.set(cacheKey, finalResult);
    }

    return finalResult;
  }

  /**
   * Répond aux demandes de synchronisation émises par content.js
   */
  window.addEventListener('__MYEPITECH_REQ_ENROLLED__', async (event) => {
    const reqYear = (event.detail && event.detail.schoolYear) || '2026';
    const result = await fetchEnrolledModules(reqYear);
    if (result) {
      window.dispatchEvent(new CustomEvent('__MYEPITECH_RES_ENROLLED__', { detail: result }));
    }
  });

  window.addEventListener('__MYEPITECH_REQ_ACADEMIC__', async (event) => {
    const semId = event.detail && event.detail.semesterId;
    const forceRefresh = event.detail && !!event.detail.forceRefresh;
    const result = await fetchAcademicData(semId, forceRefresh);
    window.dispatchEvent(new CustomEvent('__MYEPITECH_RES_ACADEMIC__', { detail: result }));
  });

  // Émission proactive dès que possible si on est sur /projects, /units ou /me/academic
  setTimeout(async () => {
    const p = window.location.pathname;
    if (p.includes('/projects') || p.includes('/units')) {
      const urlParams = new URLSearchParams(window.location.search);
      const year = urlParams.get('schoolYear') || '2026';
      const result = await fetchEnrolledModules(year);
      if (result) {
        window.dispatchEvent(new CustomEvent('__MYEPITECH_RES_ENROLLED__', { detail: result }));
      }
    } else if (p.includes('/me/academic')) {
      const result = await fetchAcademicData();
      if (result && result.validations) {
        window.dispatchEvent(new CustomEvent('__MYEPITECH_RES_ACADEMIC__', { detail: result }));
      }
    }
  }, 500);

  // Écoute immédiate des navigations SPA dans le monde principal
  function notifyRouteChange() {
    window.dispatchEvent(new CustomEvent('__MYEPITECH_ROUTE_CHANGE__', {
      detail: { url: window.location.href, pathname: window.location.pathname }
    }));
  }

  const origPushState = history.pushState;
  history.pushState = function (...args) {
    origPushState.apply(this, args);
    notifyRouteChange();
  };

  const origReplaceState = history.replaceState;
  history.replaceState = function (...args) {
    origReplaceState.apply(this, args);
    notifyRouteChange();
  };

  window.addEventListener('popstate', notifyRouteChange);
})();
