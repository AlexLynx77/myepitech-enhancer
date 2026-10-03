/**
 * MyEpitech Enhancer - Content Script
 * Gère :
 * 1. La persistance et l'application automatique des colonnes et de la pagination (Page Modules).
 * 2. L'affichage d'un badge compact d'inscription (✓ Inscrit / Ouvert / Fermé) à côté du nom du module.
 * 3. L'affichage du code complet du module (ex: G-SEC-500) sur chaque carte de projet (Page Projets).
 */

(function () {
  'use strict';

  const STORAGE_KEY = 'myepitech_modules_settings';
  const ENROLLED_MODULES_KEY = 'myepitech_enrolled_data';
  let isApplying = false;
  let lastAppliedUrl = '';
  let toastContainer = null;

  // Configuration par défaut
  const defaultSettings = {
    enabled: true,
    hideUserName: false, // Masquer le prénom et nom en haut à droite
    showBadges: true, // Badges d'inscription dans la colonne Nom (Modules)
    showProjectCodes: true, // Code complet du module sur les cartes (Projets)
    filterEnrolledProjectsOnly: false, // Filtrer uniquement les projets de ses modules (Projets)
    showGpaSimulator: true, // Simulateur de GPA sur /me/academic
    rowsPerPage: '50', // 20, 30, 50, 100, 150
    columns: {
      'Développer': true,
      'Code': true,
      'Nom': true,
      'Semestre': true,
      'Campus': true,
      'Date de début': true,
      'Date de fin': true,
      'Actions': true
    }
  };

  /**
   * Système de stockage unifié (sync avec fallback local) avec gestion des déconnexions du contexte
   */
  async function getSettings() {
    return new Promise((resolve) => {
      try {
        if (!chrome?.runtime?.id) {
          resolve(defaultSettings);
          return;
        }
        const storage = chrome.storage?.sync || chrome.storage?.local;
        if (!storage) {
          resolve(defaultSettings);
          return;
        }
        storage.get([STORAGE_KEY], (res) => {
          if (chrome.runtime?.lastError) {
            try {
              chrome.storage?.local?.get([STORAGE_KEY], (localRes) => {
                resolve(localRes && localRes[STORAGE_KEY] ? { ...defaultSettings, ...localRes[STORAGE_KEY] } : defaultSettings);
              });
            } catch (e) {
              resolve(defaultSettings);
            }
          } else {
            resolve(res && res[STORAGE_KEY] ? { ...defaultSettings, ...res[STORAGE_KEY] } : defaultSettings);
          }
        });
      } catch (e) {
        resolve(defaultSettings);
      }
    });
  }

  async function saveSettings(settings) {
    return new Promise((resolve) => {
      try {
        if (!chrome?.runtime?.id) {
          resolve();
          return;
        }
        const storage = chrome.storage?.sync || chrome.storage?.local;
        if (!storage) {
          resolve();
          return;
        }
        const data = { [STORAGE_KEY]: settings };
        storage.set(data, () => {
          if (chrome.runtime?.lastError) {
            try {
              chrome.storage?.local?.set(data, resolve);
            } catch (e) {
              resolve();
            }
          } else {
            resolve();
          }
        });
      } catch (e) {
        resolve();
      }
    });
  }

  /**
   * Applique le masquage ou l'affichage du prénom/nom de l'étudiant dans l'en-tête
   */
  function applyUserNameVisibility(hide) {
    document.documentElement.classList.toggle('myepitech-hide-user-name', Boolean(hide));
    if (document.body) {
      document.body.classList.toggle('myepitech-hide-user-name', Boolean(hide));
    }
  }

  // Application immédiate avant le rendu complet du DOM pour éviter tout scintillement
  getSettings().then((s) => {
    if (s && s.enabled && s.hideUserName) {
      applyUserNameVisibility(true);
    }
  });

  /**
   * Gestion de la persistance des modules inscrits
   * @param {string} year - Année scolaire
   * @param {string[]} newCodes - Liste des codes de modules
   * @param {boolean} isAuthoritative - Si vrai, remplace la liste de l'année au lieu d'accumuler (gestion des désinscriptions)
   */
  async function saveEnrolledModules(year, newCodes, isAuthoritative = false) {
    return new Promise((resolve) => {
      try {
        if (!chrome?.runtime?.id || !chrome?.storage?.local) return resolve();
        const storage = chrome.storage.local;
        storage.get([ENROLLED_MODULES_KEY], (res) => {
          if (chrome.runtime?.lastError) return resolve();
          const data = res && res[ENROLLED_MODULES_KEY] ? res[ENROLLED_MODULES_KEY] : { years: {}, allCodes: [] };
          if (!data.years) data.years = {};

          const yearKey = String(year || '2026');
          const cleanCodes = (newCodes || [])
            .map((c) => String(c).toUpperCase().trim())
            .filter((c) => Boolean(c) && !/^[A-Z]{2,4}-[0-9]+$/i.test(c));

          if (isAuthoritative) {
            data.years[yearKey] = Array.from(new Set(cleanCodes));
          } else {
            const existingForYear = new Set(data.years[yearKey] || []);
            cleanCodes.forEach((c) => existingForYear.add(c));
            data.years[yearKey] = Array.from(existingForYear);
          }

          const allSet = new Set();
          Object.values(data.years).forEach((list) => {
            if (Array.isArray(list)) list.forEach((c) => allSet.add(c));
          });
          data.allCodes = Array.from(allSet);
          data.lastUpdated = Date.now();

          try {
            storage.set({ [ENROLLED_MODULES_KEY]: data }, resolve);
          } catch (e) {
            resolve();
          }
        });
      } catch (e) {
        resolve();
      }
    });
  }

  /**
   * Supprime un module désinscrit de façon atomique et immédiate
   */
  async function removeEnrolledModule(year, unitCode) {
    if (!unitCode) return;
    const cleanCode = String(unitCode).toUpperCase().trim();
    return new Promise((resolve) => {
      try {
        if (!chrome?.runtime?.id || !chrome?.storage?.local) return resolve();
        const storage = chrome.storage.local;
        storage.get([ENROLLED_MODULES_KEY], (res) => {
          if (chrome.runtime?.lastError) return resolve();
          const data = res && res[ENROLLED_MODULES_KEY] ? res[ENROLLED_MODULES_KEY] : { years: {}, allCodes: [] };
          if (!data.years) data.years = {};

          const yearKey = String(year || '2026');
          if (data.years[yearKey]) {
            data.years[yearKey] = data.years[yearKey].filter((c) => String(c).toUpperCase().trim() !== cleanCode);
          }
          // Retirer également de toutes les autres années au cas où
          Object.keys(data.years).forEach((y) => {
            data.years[y] = data.years[y].filter((c) => String(c).toUpperCase().trim() !== cleanCode);
          });

          const allSet = new Set();
          Object.values(data.years).forEach((list) => {
            if (Array.isArray(list)) {
              list.forEach((c) => {
                if (String(c).toUpperCase().trim() !== cleanCode) allSet.add(c);
              });
            }
          });
          data.allCodes = Array.from(allSet);
          data.lastUpdated = Date.now();

          try {
            storage.set({ [ENROLLED_MODULES_KEY]: data }, () => {
              console.log('[MyEpitech Enhancer] Module retiré du stockage :', cleanCode);
              resolve();
            });
          } catch (e) {
            resolve();
          }
        });
      } catch (e) {
        resolve();
      }
    });
  }

  /**
   * Ajoute un module inscrit de façon atomique et immédiate
   */
  async function addEnrolledModule(year, unitCode) {
    if (!unitCode) return;
    const cleanCode = String(unitCode).toUpperCase().trim();
    return new Promise((resolve) => {
      try {
        if (!chrome?.runtime?.id || !chrome?.storage?.local) return resolve();
        const storage = chrome.storage.local;
        storage.get([ENROLLED_MODULES_KEY], (res) => {
          if (chrome.runtime?.lastError) return resolve();
          const data = res && res[ENROLLED_MODULES_KEY] ? res[ENROLLED_MODULES_KEY] : { years: {}, allCodes: [] };
          if (!data.years) data.years = {};

          const yearKey = String(year || '2026');
          const set = new Set(data.years[yearKey] || []);
          set.add(cleanCode);
          data.years[yearKey] = Array.from(set);

          const allSet = new Set(data.allCodes || []);
          allSet.add(cleanCode);
          data.allCodes = Array.from(allSet);
          data.lastUpdated = Date.now();

          try {
            storage.set({ [ENROLLED_MODULES_KEY]: data }, () => {
              console.log('[MyEpitech Enhancer] Module ajouté au stockage :', cleanCode);
              resolve();
            });
          } catch (e) {
            resolve();
          }
        });
      } catch (e) {
        resolve();
      }
    });
  }

  /**
   * Demande la liste officielle des modules inscrits au bridge (world: MAIN)
   */
  function requestEnrolledModulesFromBridge(schoolYear) {
    window.dispatchEvent(
      new CustomEvent('__MYEPITECH_REQ_ENROLLED__', {
        detail: { schoolYear: String(schoolYear || '2026') }
      })
    );
  }

  let latestUnitsDetails = null;

  // Écoute de la réponse envoyée par le script pont (world: MAIN)
  window.addEventListener('__MYEPITECH_RES_ENROLLED__', async (event) => {
    const detail = event.detail;
    if (!detail) return;

    if (detail.unitsDetails) {
      latestUnitsDetails = detail.unitsDetails;
    }

    if (Array.isArray(detail.registeredCodes)) {
      const year = String(detail.schoolYear || '2026');
      console.log('[MyEpitech Enhancer] Reçu modules inscrits officiels du pont :', detail.registeredCodes);
      await saveEnrolledModules(year, detail.registeredCodes, true);
    }

    const s = await getSettings();
    if (isProjectsPage()) {
      if (s.showProjectCodes !== false) {
        updateProjectModuleCodes(true);
      }
      await updateProjectsFilterBar();
    } else if (isUnitsPage()) {
      if (s.showBadges !== false) {
        updateEnrollmentBadges(true);
      }
    }
  });


  async function getEnrolledModules(year) {
    return new Promise((resolve) => {
      try {
        if (!chrome?.runtime?.id || !chrome?.storage?.local) return resolve(new Set());
        const storage = chrome.storage.local;
        storage.get([ENROLLED_MODULES_KEY], (res) => {
          if (chrome.runtime?.lastError) return resolve(new Set());
          const data = res && res[ENROLLED_MODULES_KEY];
          if (!data) return resolve(new Set());
          const yearKey = String(year || '');
          let list = [];
          if (yearKey && data.years && Array.isArray(data.years[yearKey])) {
            list = data.years[yearKey];
          } else if (Array.isArray(data.allCodes)) {
            list = data.allCodes;
          }
          const validList = list
            .map((c) => String(c).toUpperCase().trim())
            .filter((c) => Boolean(c) && !/^[A-Z]{2,4}-[0-9]+$/i.test(c));
          resolve(new Set(validList));
        });
      } catch (e) {
        resolve(new Set());
      }
    });
  }

  /**
   * Affichage d'un toast discret non-intrusif (style Mantine Notifications)
   */
  const SVG_ICONS = {
    check: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>',
    info: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>',
    refresh: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>',
    trash: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>',
    filter: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon></svg>'
  };

  function showToast(message, iconType = 'check') {
    if (!toastContainer) {
      toastContainer = document.createElement('div');
      toastContainer.className = 'myepitech-toast-container';
      document.body.appendChild(toastContainer);
    }

    const iconHtml = SVG_ICONS[iconType] || (iconType.startsWith('<svg') ? iconType : SVG_ICONS.check);

    const toast = document.createElement('div');
    toast.className = 'myepitech-toast';
    toast.innerHTML = `
      <span class="myepitech-toast-icon">${iconHtml}</span>
      <span class="myepitech-toast-text"></span>
    `;
    toast.querySelector('.myepitech-toast-text').textContent = message;

    toastContainer.appendChild(toast);
    requestAnimationFrame(() => {
      toast.classList.add('show');
    });

    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => {
        toast.remove();
      }, 300);
    }, 2400);
  }

  /**
   * Vérifications de la page active
   */
  function isUnitsPage() {
    const p = window.location.pathname;
    return p.startsWith('/units') && !p.includes('/projects/');
  }

  function isProjectsPage() {
    const p = window.location.pathname;
    return p === '/projects' || p === '/projects/';
  }

  function isAcademicPage() {
    return window.location.pathname.includes('/me/academic');
  }

  /**
   * Attente d'un élément dans le DOM
   */
  function waitForElement(selector, timeout = 7000) {
    return new Promise((resolve) => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);

      const observer = new MutationObserver(() => {
        const found = document.querySelector(selector);
        if (found) {
          observer.disconnect();
          resolve(found);
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        observer.disconnect();
        resolve(document.querySelector(selector));
      }, timeout);
    });
  }

  /**
   * Application de la pagination (nombre de lignes par page)
   */
  async function applyPagination(targetRows) {
    if (!targetRows) return false;

    const rppInput = document.querySelector('input[aria-labelledby="rpp-label"]');
    if (!rppInput) return false;

    if (rppInput.value === String(targetRows)) {
      return false; // Déjà appliqué
    }

    // Ouvrir le menu Mantine Select
    const wrapper = rppInput.closest('.mantine-Select-wrapper') || rppInput;
    wrapper.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    wrapper.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    wrapper.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // Attendre l'apparition du dropdown
    await new Promise((r) => setTimeout(r, 60));

    // Chercher l'option correspondante
    const options = Array.from(document.querySelectorAll('.mantine-Select-option, [role="option"]'));
    const targetOption = options.find((opt) => (opt.getAttribute('value') || opt.innerText.trim()) === String(targetRows));

    if (targetOption) {
      targetOption.click();
      return true;
    }

    return false;
  }

  /**
   * Application des colonnes sauvegardées
   */
  async function applyColumns(savedColumns) {
    if (!savedColumns || Object.keys(savedColumns).length === 0) return false;

    const colBtn = document.querySelector('button[aria-label="Afficher/Masquer les colonnes"]');
    if (!colBtn) return false;

    // Ajouter une classe temporaire sur le body pour masquer visuellement l'ouverture du menu pendant la synchro
    document.body.classList.add('myepitech-silent-sync-active');

    // Ouvrir le menu des colonnes
    colBtn.click();
    await new Promise((r) => setTimeout(r, 60));

    const menu = document.querySelector('.mrt-show-hide-columns-menu');
    if (!menu) {
      document.body.classList.remove('myepitech-silent-sync-active');
      return false;
    }

    // Masquer le menu pendant les clics automatiques
    menu.classList.add('myepitech-silent-sync');

    let changesMade = 0;
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));

    for (const item of items) {
      const labelEl = item.querySelector('.mantine-Switch-label');
      const input = item.querySelector('input[type="checkbox"]');

      if (labelEl && input && !input.disabled) {
        const colName = labelEl.innerText.trim();
        if (colName in savedColumns) {
          const desiredState = Boolean(savedColumns[colName]);
          const currentState = Boolean(input.checked);

          if (desiredState !== currentState) {
            input.click();
            changesMade++;
            await new Promise((r) => setTimeout(r, 20));
          }
        }
      }
    }

    // Refermer le menu proprement
    colBtn.click();
    await new Promise((r) => setTimeout(r, 30));
    menu.classList.remove('myepitech-silent-sync');
    document.body.classList.remove('myepitech-silent-sync-active');

    return changesMade > 0;
  }

  /**
   * Extrait le code officiel du module (ex: G-CNA-500) en évitant les codes d'instances de campus (ex: MAR-1, PAR-1)
   */
  function extractValidUnitCode(orig) {
    if (!orig) return null;
    const candidates = [orig.unitCode, orig.code, orig.id, orig.unit && orig.unit.code];
    // 1. Chercher un code de format standard (ex: G-CNA-500, B-INN-000, S-EPI-000)
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) {
        const trimmed = c.trim().toUpperCase();
        if (/^[A-Z0-9]+-[A-Z0-9]+-[0-9]+/i.test(trimmed)) {
          return trimmed;
        }
      }
    }
    // 2. Éviter explicitement les codes de campus (ex: MAR-1, PAR-1, TLS-1, ALL-1)
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) {
        const trimmed = c.trim().toUpperCase();
        if (!/^[A-Z]{2,4}-[0-9]+$/i.test(trimmed)) {
          return trimmed;
        }
      }
    }
    return orig.unitCode || orig.code || null;
  }

  /**
   * Injection et mise à jour des badges d'inscription dans la colonne 'Nom' (Page Modules)
   * Récupère et sauvegarde également tous les modules auxquels l'étudiant est inscrit.
   */
  function updateEnrollmentBadges(enabled = true) {
    if (!isUnitsPage()) return;

    if (!enabled) {
      document.querySelectorAll('.myepitech-enroll-badge').forEach((b) => b.remove());
      return;
    }

    const rows = document.querySelectorAll('tbody tr[data-hover="true"]:not(.mantine-Table-tr-detail-panel)');
    if (!rows.length) return;

    const enrolledCodes = new Set();
    const urlParams = new URLSearchParams(window.location.search);
    let schoolYear = urlParams.get('schoolYear') || new Date().getFullYear().toString();

    // Déclencher la synchronisation directe via le pont si plus de 5s depuis la dernière
    const nowSync = Date.now();
    if (nowSync - lastBridgeSync > 5000) {
      lastBridgeSync = nowSync;
      requestEnrolledModulesFromBridge(schoolYear);
    }

    rows.forEach((row) => {
      let nameCell = row.querySelector('td[data-index="2"]');
      let anchor = nameCell ? nameCell.querySelector('a[href*="/units/"]') : null;

      if (!anchor) {
        anchor = row.querySelector('a[href*="/units/"]');
        if (anchor) nameCell = anchor.closest('td');
      }

      // Trouver le code du module
      let unitCode = null;
      const codeCell = row.querySelector('td[data-index="1"], td[data-index="0"]');
      if (codeCell && codeCell.innerText.trim()) {
        unitCode = codeCell.innerText.trim();
      }
      if (!unitCode && anchor) {
        const href = anchor.getAttribute('href') || '';
        const m = href.match(/\/units\/(?:(\d+)\/)?([^\/?#]+)/i);
        if (m) {
          if (m[1]) schoolYear = m[1];
          unitCode = m[2];
        }
      }
      if (unitCode) {
        unitCode = String(unitCode).toUpperCase().trim();
      }

      // 1. Déterminer si l'étudiant est inscrit et si les inscriptions sont ouvertes
      let isRegistered = false;
      let isOpen = false;

      // Méthode 1 : Données officielles issues du pont / API (apiContext)
      if (unitCode && latestUnitsDetails && latestUnitsDetails[unitCode]) {
        const info = latestUnitsDetails[unitCode];
        isRegistered = Boolean(info.isRegistered);
        if (!isRegistered) {
          isOpen = Boolean(info.isOpen);
        }
      }

      // Méthode 2 : Bouton d'action dans la ligne (colonne Actions data-index="6")
      const allButtons = Array.from(row.querySelectorAll('button'));
      const actionBtn = allButtons.find((b) => {
        const t = (b.textContent || '').toUpperCase();
        return t.includes("S'INSCRIRE") || t.includes("DÉSINSCRIRE") ||
               b.querySelector('.tabler-icon-user-plus') ||
               b.querySelector('.tabler-icon-user-minus');
      }) || row.querySelector('td[data-index="6"] button, td[data-index="7"] button, td:last-child button');

      if (actionBtn) {
        const text = (actionBtn.textContent || '').toUpperCase();
        const aria = (actionBtn.getAttribute('aria-label') || '').toUpperCase();
        const hasMinus = Boolean(actionBtn.querySelector('.tabler-icon-user-minus'));
        const hasPlus = Boolean(actionBtn.querySelector('.tabler-icon-user-plus'));

        if (text.includes('DÉSINSCRIRE') || aria.includes('DÉSINSCRIRE') || hasMinus) {
          isRegistered = true;
        } else if (text.includes("S'INSCRIRE") || aria.includes("S'INSCRIRE") || hasPlus) {
          const disabled = actionBtn.disabled || actionBtn.getAttribute('data-disabled') === 'true';
          if (!isRegistered) {
            // Si le bouton est explicitement désactivé (pas encore ouvert ou fermé), isOpen est FAUX
            isOpen = !disabled;
          }
        }
      }

      // Collecter le module s'il est inscrit
      if (isRegistered && unitCode) {
        enrolledCodes.add(String(unitCode).toUpperCase().trim());
      }

      if (!nameCell || !anchor) return;

      const expectedType = isRegistered ? 'enrolled' : (isOpen ? 'open' : 'closed');

      // Vérifier si le badge existe déjà
      const existingBadge = nameCell.querySelector('.myepitech-enroll-badge');
      if (existingBadge) {
        if (existingBadge.dataset.status === expectedType) {
          return; // Déjà à jour
        }
        existingBadge.remove();
      }

      const badge = document.createElement('span');
      badge.className = `myepitech-enroll-badge ${expectedType}`;
      badge.dataset.status = expectedType;

      if (isRegistered) {
        badge.innerHTML = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:3px;display:inline-block;vertical-align:-1px;"><polyline points="20 6 9 17 4 12"></polyline></svg>Inscrit';
        badge.title = 'Vous êtes inscrit à ce module';
      } else if (isOpen) {
        badge.innerHTML = 'Ouvert';
        badge.title = 'Inscriptions ouvertes';
      } else {
        badge.innerHTML = 'Fermé';
        badge.title = 'Inscriptions fermées';
      }

      anchor.insertAdjacentElement('beforebegin', badge);
    });

    // Scanner également le modèle complet de table MRT via React Fiber (toutes pages confondues)
    let fiberTableScanned = false;
    try {
      const tableEl = document.querySelector('table');
      if (tableEl) {
        const fiberKey = Object.keys(tableEl).find((k) => k.startsWith('__reactFiber'));
        let curr = tableEl[fiberKey];
        while (curr) {
          const table = curr.memoizedProps && curr.memoizedProps.table;
          if (table && typeof table.getPrePaginationRowModel === 'function') {
            const allRows = table.getPrePaginationRowModel().rows;
            if (allRows && allRows.length) {
              enrolledCodes.clear(); // Vider pour avoir l'état exact actuel
              allRows.forEach((r) => {
                const orig = r.original;
                const uCode = extractValidUnitCode(orig);
                if (orig && orig.isRegistered && uCode) {
                  enrolledCodes.add(uCode);
                }
              });
              fiberTableScanned = true;
            }
            break;
          }
          curr = curr.return;
        }
      }
    } catch (e) {
      // Ignorer si la table n'est pas encore prête
    }

    // Sauvegarde autoritaire : remplace la liste de l'année pour supprimer les désinscriptions
    saveEnrolledModules(schoolYear, Array.from(enrolledCodes), fiberTableScanned);
    console.log('[MyEpitech Enhancer] Modules inscrits synchronisés (Modules) :', Array.from(enrolledCodes));
  }

  /**
   * Retourne toutes les cartes de projets actuellement dans le DOM
   */
  function getAllProjectCards() {
    return Array.from(document.querySelectorAll('a[href*="/units/"][href*="/projects/"]'));
  }

  /**
   * Extrait le code complet du module (ex: G-SEC-500) depuis une carte de projet
   */
  function getUnitCodeFromCard(card) {
    if (!card) return '';
    const href = card.getAttribute('href') || '';
    const match = href.match(/\/units\/(?:\d{4}\/)?([A-Z0-9_\-]+)\//i);
    if (match && match[1]) {
      return match[1].toUpperCase().trim();
    }

    try {
      const fiberKey = Object.keys(card).find((k) => k.startsWith('__reactFiber'));
      if (fiberKey) {
        let curr = card[fiberKey];
        let depth = 0;
        while (curr && depth < 20) {
          if (curr.memoizedProps && curr.memoizedProps.project) {
            const p = curr.memoizedProps.project;
            const u = p.unitInstance || p;
            const code = u.unitCode || u.code;
            if (code) return String(code).toUpperCase().trim();
          }
          curr = curr.return;
          depth++;
        }
      }
    } catch (e) {}

    return '';
  }

  /**
   * Détermine le meilleur point d'insertion pour la barre de contrôle des projets
   */
  function getProjectsFilterBarInsertionPoint() {
    const firstHeading = document.querySelector('main h2, h2');
    if (firstHeading) {
      return { target: firstHeading, position: 'beforebegin' };
    }

    const firstCard = document.querySelector('a[href*="/units/"][href*="/projects/"]');
    if (firstCard) {
      const grid = firstCard.closest('.mantine-SimpleGrid-root') || firstCard.parentElement;
      if (grid) {
        return { target: grid, position: 'beforebegin' };
      }
    }

    const main = document.querySelector('main');
    if (main) {
      return { target: main, position: 'afterbegin' };
    }

    return null;
  }

  /**
   * Injection du code complet du module sur les cartes de la page Projets (ex: G-SEC-500)
   * Ajoute également une mise en avant distinctive si l'étudiant est inscrit au module.
   */
  async function updateProjectModuleCodes(enabled = true, enrolledSet = null) {
    if (!isProjectsPage()) return;

    if (!enabled) {
      document.querySelectorAll('.myepitech-project-code-badge').forEach((b) => b.remove());
      return;
    }

    const cards = getAllProjectCards();
    if (!cards.length) return;

    if (!enrolledSet) {
      const urlParams = new URLSearchParams(window.location.search);
      const schoolYear = urlParams.get('schoolYear') || '2026';
      enrolledSet = await getEnrolledModules(schoolYear);
    }

    cards.forEach((card) => {
      const unitCode = getUnitCodeFromCard(card);
      if (!unitCode) return;

      const isEnrolled = Boolean(enrolledSet && enrolledSet.has(unitCode));

      // Trouver le paragraphe du sous-titre du module
      const subtitleP = card.querySelector('p[style*="color: var(--mantine-color-dimmed)"], p[data-size="xs"]');
      if (!subtitleP) return;

      let badge = subtitleP.querySelector('.myepitech-project-code-badge');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'myepitech-project-code-badge';
        subtitleP.insertAdjacentElement('afterbegin', badge);
      }

      if (isEnrolled) {
        badge.classList.add('enrolled');
        badge.innerHTML = `<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:3px;display:inline-block;vertical-align:-1px;"><polyline points="20 6 9 17 4 12"></polyline></svg>${unitCode}`;
        badge.title = `Module inscrit : ${unitCode}`;
      } else {
        badge.classList.remove('enrolled');
        badge.textContent = unitCode;
        badge.title = `Module : ${unitCode}`;
      }
    });
  }

  /**
   * Nettoie les éléments de la page Projets lorsqu'on navigue hors de /projects
   */
  function cleanUpProjectsElements() {
    const filterBars = document.querySelectorAll('.myepitech-projects-filter-bar');
    filterBars.forEach((b) => b.remove());
  }

  /**
   * Détecte et clique automatiquement sur les boutons et commutateurs "Afficher plus" de la page Projets
   */
  function autoExpandShowMore() {
    if (!isProjectsPage()) return;

    // 1. Boutons "Afficher plus", "Voir plus", "Charger plus"
    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    candidates.forEach((el) => {
      const text = (el.innerText || el.textContent || '').trim().toLowerCase();
      if (
        text === 'afficher plus' ||
        text === 'voir plus' ||
        text.startsWith('afficher plus') ||
        text.startsWith('voir plus') ||
        text.includes('projets passés') ||
        text.includes('plus de projets') ||
        text.includes('show more') ||
        text.includes('load more')
      ) {
        const isVisible = (el.offsetParent !== null) || !('offsetParent' in el);
        if (!el.disabled && !el.dataset.myepitechAutoClicked && isVisible) {
          el.dataset.myepitechAutoClicked = 'true';
          console.log('[MyEpitech Enhancer] Expansion automatique :', text);
          el.click();
          setTimeout(() => {
            if (el) delete el.dataset.myepitechAutoClicked;
          }, 2500);
        }
      }
    });

    // 2. Interrupteurs / cases à cocher "Afficher plus" ou "Projets passés"
    const switches = Array.from(document.querySelectorAll('input[type="checkbox"], [role="switch"]'));
    switches.forEach((sw) => {
      const parent = sw.closest('label, div') || sw.parentElement;
      const text = (parent ? parent.innerText || parent.textContent : '').toLowerCase();
      if (
        text.includes('afficher plus') ||
        text.includes('voir plus') ||
        text.includes('projets passés') ||
        text.includes('projets terminés')
      ) {
        const isChecked = sw.checked || sw.getAttribute('aria-checked') === 'true';
        if (!isChecked) {
          sw.click();
          console.log('[MyEpitech Enhancer] Activation automatique switch :', text);
        }
      }
    });
  }

  /**
   * Crée la barre de contrôle segmentée (une seule fois) avec écouteurs persistants
   */
  function ensureProjectsFilterBar() {
    if (!isProjectsPage()) {
      cleanUpProjectsElements();
      return null;
    }

    let filterBar = document.querySelector('.myepitech-projects-filter-bar');
    if (filterBar) return filterBar;

    const insertion = getProjectsFilterBarInsertionPoint();
    if (!insertion || !insertion.target) return null;

    filterBar = document.createElement('div');
    filterBar.className = 'myepitech-projects-filter-bar';
    filterBar.innerHTML = `
      <div class="myepitech-filter-group">
        <div class="myepitech-segmented-control" role="tablist">
          <button type="button" class="myepitech-seg-btn active" data-filter="all" title="Afficher tous les projets disponibles">
            <svg class="myepitech-seg-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="7" height="7"></rect>
              <rect x="14" y="3" width="7" height="7"></rect>
              <rect x="14" y="14" width="7" height="7"></rect>
              <rect x="3" y="14" width="7" height="7"></rect>
            </svg>
            <span>Tous les projets</span>
            <span class="myepitech-pill-count count-all">0</span>
          </button>
          <button type="button" class="myepitech-seg-btn" data-filter="enrolled" title="Afficher uniquement les projets de vos modules inscrits">
            <svg class="myepitech-seg-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M9 11l3 3L22 4"></path>
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>
            </svg>
            <span>Mes modules inscrits</span>
            <span class="myepitech-pill-count count-enrolled">0</span>
          </button>
        </div>
        <button type="button" class="myepitech-refresh-btn" title="Synchroniser vos inscriptions en direct depuis My Epitech">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M20 11A8.1 8.1 0 0 0 4.5 9M4 5v4h4m-4 4a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/>
          </svg>
          <span>Actualiser</span>
        </button>
      </div>
      <div class="myepitech-filter-info"></div>
    `;

    // Écouteur unique et persistant par délégation d'événement
    filterBar.addEventListener('click', async (e) => {
      const refreshBtn = e.target && e.target.closest ? e.target.closest('.myepitech-refresh-btn') : null;
      if (refreshBtn) {
        e.preventDefault();
        e.stopPropagation();
        refreshBtn.classList.add('spinning');
        showToast('Synchronisation des inscriptions en cours...', 'refresh');
        const urlParams = new URLSearchParams(window.location.search);
        const schoolYear = urlParams.get('schoolYear') || '2026';
        requestEnrolledModulesFromBridge(schoolYear);
        setTimeout(() => refreshBtn.classList.remove('spinning'), 1200);
        return;
      }

      const btn = e.target && e.target.closest ? e.target.closest('button[data-filter]') : null;
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();

      const filterType = btn.getAttribute('data-filter');
      const isEnrolledOnly = (filterType === 'enrolled');

      const s = await getSettings();
      s.filterEnrolledProjectsOnly = isEnrolledOnly;
      await saveSettings(s);

      await updateProjectsFilterBar();
      showToast(
        isEnrolledOnly ? 'Affichage : Projets des modules inscrits' : 'Affichage de tous les projets',
        'filter'
      );
    });

    insertion.target.insertAdjacentElement(insertion.position, filterBar);
    return filterBar;
  }

  let isFilterUpdating = false;
  let lastBridgeSync = 0;

  /**
   * Met à jour l'affichage de la barre de contrôle et applique le filtrage
   */
  async function updateProjectsFilterBar() {
    if (!isProjectsPage()) {
      cleanUpProjectsElements();
      return;
    }

    if (isFilterUpdating) return;
    isFilterUpdating = true;

    try {
      const settings = await getSettings();
      let filterBar = document.querySelector('.myepitech-projects-filter-bar');

      if (!settings.enabled) {
        if (filterBar) filterBar.remove();
        getAllProjectCards().forEach((card) => {
          card.classList.remove('myepitech-project-card-hidden');
          if (card.style) {
            if (card.style.removeProperty) card.style.removeProperty('display');
            else card.style.display = '';
          }
        });
        return;
      }

      // S'assurer que la barre est créée
      filterBar = ensureProjectsFilterBar();

      const urlParams = new URLSearchParams(window.location.search);
      const schoolYear = urlParams.get('schoolYear') || '2026';

      // Déclencher la synchronisation directe via le pont si plus de 5s depuis la dernière
      const now = Date.now();
      if (now - lastBridgeSync > 5000) {
        lastBridgeSync = now;
        requestEnrolledModulesFromBridge(schoolYear);
      }

      const enrolledSet = await getEnrolledModules(schoolYear);
      const cards = getAllProjectCards();

      const isEnrolledFilter = Boolean(settings.filterEnrolledProjectsOnly);

      // Appliquer le filtrage sur le DOM
      let visibleCount = 0;
      let enrolledCount = 0;

      cards.forEach((card) => {
        const unitCode = getUnitCodeFromCard(card);
        const isEnrolled = Boolean(unitCode && enrolledSet.has(unitCode));

        if (isEnrolled) {
          enrolledCount++;
        }

        if (isEnrolledFilter) {
          if (isEnrolled) {
            card.classList.remove('myepitech-project-card-hidden');
            if (card.style) {
              if (card.style.removeProperty) card.style.removeProperty('display');
              else card.style.display = '';
            }
            visibleCount++;
          } else {
            card.classList.add('myepitech-project-card-hidden');
            if (card.style) card.style.display = 'none';
          }
        } else {
          card.classList.remove('myepitech-project-card-hidden');
          if (card.style) {
            if (card.style.removeProperty) card.style.removeProperty('display');
            else card.style.display = '';
          }
          visibleCount++;
        }
      });

      // Mettre à jour les éléments de la barre de filtre s'ils existent
      if (filterBar) {
        const btnAll = filterBar.querySelector('button[data-filter="all"]');
        const btnEnrolled = filterBar.querySelector('button[data-filter="enrolled"]');
        const countAllEl = filterBar.querySelector('.count-all');
        const countEnrolledEl = filterBar.querySelector('.count-enrolled');
        const infoEl = filterBar.querySelector('.myepitech-filter-info');

        if (btnAll) btnAll.classList.toggle('active', !isEnrolledFilter);
        if (btnEnrolled) btnEnrolled.classList.toggle('active', isEnrolledFilter);
        if (countAllEl) countAllEl.textContent = String(cards.length);
        if (countEnrolledEl) countEnrolledEl.textContent = String(enrolledCount);

        if (infoEl) {
          if (enrolledSet.size === 0 && enrolledCount === 0) {
            infoEl.innerHTML = `
              <div class="myepitech-filter-alert">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
                <span>Inscriptions non synchronisées.</span>
                <a href="/units/my?schoolYear=${schoolYear}&cursus=PGE" class="myepitech-filter-sync-link">Ouvrir Modules pour synchroniser</a>
              </div>
            `;
          } else {
            infoEl.textContent = isEnrolledFilter
              ? `${visibleCount} sur ${cards.length} projets affichés`
              : `${cards.length} projet${cards.length > 1 ? 's' : ''}`;
          }
        }
      }

      // Mettre à jour aussi les badges de code sur les cartes
      if (settings.showProjectCodes !== false) {
        updateProjectModuleCodes(true, enrolledSet);
      }
    } catch (err) {
      console.error('[MyEpitech Enhancer] Erreur dans updateProjectsFilterBar :', err);
    } finally {
      isFilterUpdating = false;
    }
  }

  /**
   * Initialisation continue pour la page Projets (avec boucle de réessais)
   */
  function initProjectsPage() {
    if (!isProjectsPage()) {
      cleanUpProjectsElements();
      return;
    }

    autoExpandShowMore();
    updateProjectsFilterBar();
    updateProjectModuleCodes(true);

    let attempts = 0;
    const interval = setInterval(async () => {
      attempts++;
      if (!isProjectsPage()) {
        clearInterval(interval);
        cleanUpProjectsElements();
        return;
      }

      autoExpandShowMore();
      updateProjectsFilterBar();
      updateProjectModuleCodes(true);

      const cards = getAllProjectCards();
      const filterBar = document.querySelector('.myepitech-projects-filter-bar');

      if ((cards.length > 0 && filterBar) || attempts >= 15) {
        clearInterval(interval);
      }
    }, 400);
  }

  /**
   * Restauration complète des préférences (Page Modules)
   */
  async function restorePreferences(forced = false) {
    cleanUpProjectsElements();
    if (!isUnitsPage()) return;
    if (isApplying) return;

    const currentUrl = window.location.href;
    if (!forced && lastAppliedUrl === currentUrl) return;

    isApplying = true;

    try {
      const settings = await getSettings();
      if (!settings.enabled) {
        updateEnrollmentBadges(false);
        isApplying = false;
        return;
      }

      // Attendre que la table MRT soit dans le DOM
      const paginator = await waitForElement('[class*="paginator-container"], input[aria-labelledby="rpp-label"]', 5000);
      if (!paginator) {
        isApplying = false;
        return;
      }

      // Petite pause pour s'assurer que React a fini son premier render
      await new Promise((r) => setTimeout(r, 120));

      let paginChanged = false;
      if (settings.rowsPerPage) {
        paginChanged = await applyPagination(settings.rowsPerPage);
      }

      let colChanged = false;
      if (settings.columns) {
        colChanged = await applyColumns(settings.columns);
      }

      // Mise à jour des badges d'inscription
      updateEnrollmentBadges(settings.showBadges !== false);

      lastAppliedUrl = currentUrl;

      if (paginChanged || colChanged) {
        const details = [];
        if (paginChanged) details.push(`${settings.rowsPerPage} lignes`);
        if (colChanged) details.push('colonnes synchronisées');
        showToast(`Préférences restaurées (${details.join(', ')})`, 'check');
      }
    } catch (err) {
      console.error('[MyEpitech Enhancer] Erreur lors de la restauration :', err);
    } finally {
      isApplying = false;
    }
  }

  /**
   * Écoute des modifications utilisateur pour les sauvegarder automatiquement
   */
  function setupUserChangeListeners() {
    // 1. Détection des changements de pagination par clic utilisateur
    document.addEventListener('click', async (e) => {
      const option = e.target.closest('.mantine-Select-option, [role="option"]');
      if (!option) return;

      const rppInput = document.querySelector('input[aria-labelledby="rpp-label"]');
      if (!rppInput) return;

      const val = option.getAttribute('value') || option.innerText.trim();
      if (['20', '30', '50', '100', '150'].includes(val)) {
        const settings = await getSettings();
        if (settings.rowsPerPage !== val) {
          settings.rowsPerPage = val;
          await saveSettings(settings);
          showToast(`Affichage : ${val} lignes par défaut mémorisé`, 'check');
        }
      }
    }, true);

    // 2. Détection des changements de colonnes par clic utilisateur
    document.addEventListener('change', async (e) => {
      const target = e.target;
      if (!target || target.type !== 'checkbox') return;

      const menuItem = target.closest('.mrt-show-hide-columns-menu [role="menuitem"]');
      if (!menuItem) return;

      const labelEl = menuItem.querySelector('.mantine-Switch-label');
      if (!labelEl) return;

      const colName = labelEl.innerText.trim();
      const isChecked = target.checked;

      const settings = await getSettings();
      if (!settings.columns) settings.columns = {};
      settings.columns[colName] = isChecked;

      await saveSettings(settings);
      showToast(`Colonne "${colName}" ${isChecked ? 'affichée' : 'masquée'} (mémorisée)`, 'check');
    }, true);
    // 3. Détection des clics sur S'inscrire / Se désinscrire (tableaux, fiches modules et modales de confirmation)
    let pendingActionUnit = null;

    document.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('button, a, [role="button"]') : null;
      if (!btn) return;

      const txt = (btn.innerText || btn.textContent || '').toUpperCase().trim();
      const aria = (btn.getAttribute('aria-label') || '').toUpperCase();
      const isUnregister = txt.includes('DÉSINSCRIRE') || txt.includes('DESINSCRIRE') || aria.includes('DÉSINSCRIRE') || aria.includes('DESINSCRIRE') || Boolean(btn.querySelector('.tabler-icon-user-minus'));
      const isRegister = (txt.includes('INSCRIRE') || aria.includes('INSCRIRE') || Boolean(btn.querySelector('.tabler-icon-user-plus'))) && !isUnregister;

      const urlParams = new URLSearchParams(window.location.search);
      let schoolYear = urlParams.get('schoolYear') || '2026';
      let unitCode = null;

      // Cas 1 : Ligne de tableau (Page Modules)
      const row = btn.closest('tr, [role="row"]');
      if (row) {
        const codeCell = row.querySelector('td[data-index="1"], td[data-index="0"]');
        if (codeCell && codeCell.innerText.trim()) {
          unitCode = codeCell.innerText.trim();
        }
        if (!unitCode) {
          const anchor = row.querySelector('a[href*="/units/"]');
          if (anchor) {
            const m = (anchor.getAttribute('href') || '').match(/\/units\/(?:(\d{4})\/)?([^\/?#]+)/i);
            if (m) {
              if (m[1]) schoolYear = m[1];
              unitCode = m[2];
            }
          }
        }
      }

      // Cas 2 : Page détaillée d'un module ou d'un projet
      if (!unitCode) {
        const m = window.location.pathname.match(/\/units\/(?:(\d{4})\/)?([A-Z0-9_\-]+)/i);
        if (m) {
          if (m[1]) schoolYear = m[1];
          unitCode = m[2];
        }
      }

      // Cas 3 : Bouton de validation d'une modale Mantine (ex: "Confirmer" / "Valider")
      if (txt === 'CONFIRMER' || txt === 'VALIDER' || txt === 'OUI' || (txt.includes('DÉSINSCRIRE') && btn.closest('.mantine-Modal-root, [role="dialog"]'))) {
        const modal = btn.closest('.mantine-Modal-root, [role="dialog"]');
        if (modal && pendingActionUnit) {
          if (pendingActionUnit.action === 'unregister') {
            removeEnrolledModule(pendingActionUnit.year, pendingActionUnit.unitCode);
            showToast(`Désinscription : ${pendingActionUnit.unitCode} retiré`, 'trash');
          } else if (pendingActionUnit.action === 'register') {
            addEnrolledModule(pendingActionUnit.year, pendingActionUnit.unitCode);
            showToast(`Inscription : ${pendingActionUnit.unitCode} mémorisé`, 'check');
          }
          pendingActionUnit = null;
          return;
        }
      }

      if (isUnregister && unitCode) {
        pendingActionUnit = { action: 'unregister', year: schoolYear, unitCode };
        removeEnrolledModule(schoolYear, unitCode);
        showToast(`Désinscription : ${unitCode} retiré`, 'trash');
        setTimeout(() => {
          if (isUnitsPage()) updateEnrollmentBadges(true);
          else if (isProjectsPage()) updateProjectsFilterBar();
        }, 800);
        setTimeout(() => {
          if (isUnitsPage()) updateEnrollmentBadges(true);
          else if (isProjectsPage()) updateProjectsFilterBar();
        }, 2200);
      } else if (isRegister && unitCode) {
        pendingActionUnit = { action: 'register', year: schoolYear, unitCode };
        addEnrolledModule(schoolYear, unitCode);
        showToast(`Inscription : ${unitCode} mémorisé`, 'check');
        setTimeout(() => {
          if (isUnitsPage()) updateEnrollmentBadges(true);
          else if (isProjectsPage()) updateProjectsFilterBar();
        }, 800);
        setTimeout(() => {
          if (isUnitsPage()) updateEnrollmentBadges(true);
          else if (isProjectsPage()) updateProjectsFilterBar();
        }, 2200);
      }
    }, true);
  }

  /* ==========================================================================
     SIMULATEUR DE GPA & PARCOURS ACADÉMIQUE (/me/academic)
     ========================================================================== */

  let academicDataCache = null;
  let simulatedGradesState = {}; // { [blockId]: 'A' | 'B' | 'C' | 'D' | 'E' | '-' }
  let isGpaTabActive = false;
  let currentSelectedSemesterId = null;

  const GRADE_POINTS = {
    'A': 4.0,
    'B': 3.0,
    'C': 2.0,
    'D': 1.0,
    'E': 0.0,
    'Fail': 0.0
  };

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  let academicDataLoading = false;
  let academicDataError = null;
  let academicDataTimeoutId = null;

  function requestAcademicData(semesterId, forceRefresh = false) {
    academicDataLoading = true;
    academicDataError = null;

    if (academicDataTimeoutId) {
      clearTimeout(academicDataTimeoutId);
    }

    // Si aucune réponse reçue au bout de 4 secondes, on lève l'état de chargement infini
    academicDataTimeoutId = setTimeout(() => {
      if (academicDataLoading) {
        academicDataLoading = false;
        if (!academicDataCache || !academicDataCache.validations) {
          academicDataError = 'Délai d’attente dépassé lors de la récupération du parcours académique.';
        }
        if (isAcademicPage() && isGpaTabActive) {
          renderGpaSimulator();
        }
      }
    }, 4000);

    window.dispatchEvent(new CustomEvent('__MYEPITECH_REQ_ACADEMIC__', {
      detail: { semesterId, forceRefresh }
    }));
  }

  window.addEventListener('__MYEPITECH_RES_ACADEMIC__', (event) => {
    if (academicDataTimeoutId) {
      clearTimeout(academicDataTimeoutId);
      academicDataTimeoutId = null;
    }
    academicDataLoading = false;

    if (event && event.detail) {
      academicDataCache = event.detail;
      if (!academicDataCache.validations || !Array.isArray(academicDataCache.validations.blocks)) {
        academicDataError = 'Données de modules indisponibles pour ce semestre.';
      } else {
        academicDataError = null;
      }
      if (isAcademicPage() && isGpaTabActive) {
        renderGpaSimulator();
      }
    } else {
      academicDataError = 'Réponse vide du serveur.';
      if (isAcademicPage() && isGpaTabActive) {
        renderGpaSimulator();
      }
    }
  });

  function getEnrolledModulesList() {
    if (!academicDataCache || !academicDataCache.validations || !Array.isArray(academicDataCache.validations.blocks)) {
      return [];
    }
    const blocks = academicDataCache.validations.blocks;
    const blockModules = academicDataCache.blockModules;
    // Sans données de rattachement (API indisponible), on ne filtre pas plutôt que de tout masquer
    const canFilterByModules = Boolean(blockModules) && Object.keys(blockModules).length > 0;

    return blocks.filter((b) => {
      // Ignorer uniquement les UEs non concernées sans opportunité ni note
      if (b.hasOpportunity === false && (!b.grade || b.grade === '-')) return false;

      // Ignorer les UEs dont aucun module n'est dans les inscriptions de l'étudiant
      if (canFilterByModules) {
        const entry = blockModules[b.id];
        if (!entry || (entry.modules.length === 0 && !entry.transversal)) return false;
      }
      return true;
    });
  }

  function calculateGpaStats() {
    const modules = getEnrolledModulesList();

    // 1. Récupération du GPA officiel actuel
    let officialGpa = null;
    const officialGpaRaw = academicDataCache?.profile?.gpa || academicDataCache?.user?.gpa || academicDataCache?.credits?.gpa;
    if (officialGpaRaw !== undefined && officialGpaRaw !== null) {
      const parsed = parseFloat(officialGpaRaw);
      if (!isNaN(parsed)) officialGpa = parsed;
    }
    if (officialGpa === null || isNaN(officialGpa)) {
      // Extraction de secours depuis la carte profil officielle dans le DOM (ex: "gpa 3.03")
      const scolariteText = document.body.innerText || '';
      const gpaMatch = scolariteText.match(/\bgpa\s*[:\s]?\s*([0-4](?:\.\d{1,2})?)\b/i);
      if (gpaMatch) {
        officialGpa = parseFloat(gpaMatch[1]);
      }
    }

    // 2. Crédits acquis historiques avant ce semestre
    let totalAcquiredCredits = Number(academicDataCache?.credits?.totalAcquiredCredits ?? academicDataCache?.validations?.totalAcquiredCredits);
    if (isNaN(totalAcquiredCredits)) {
      const validations = academicDataCache?.validations;
      totalAcquiredCredits = (Number(validations?.acquiredCredits) || 0) + (Number(validations?.priorCredits) || 0);
    }

    // Soustraire uniquement les crédits de ce semestre qui sont déjà officiellement acquis / validés
    let currentSemValidatedCredits = 0;
    modules.forEach((m) => {
      if (m.grade && m.grade !== 'in progress' && m.grade !== '-' && m.grade !== 'Fail' && m.grade !== 'E' && m.allLearningOutcomesValidated) {
        currentSemValidatedCredits += (Number(m.credits) || 0);
      }
    });
    const pastAcquiredCredits = Math.max(0, totalAcquiredCredits - currentSemValidatedCredits);

    // 3. Modules simulés pour ce semestre (uniquement ceux avec un grade explicitement choisi)
    let simPoints = 0;
    let simGradedCredits = 0;
    let simModulesCount = 0;

    modules.forEach((m) => {
      const credits = Number(m.credits) || 0;
      const simGrade = simulatedGradesState[m.id];
      if (simGrade && simGrade !== '-' && GRADE_POINTS[simGrade] !== undefined) {
        const pts = GRADE_POINTS[simGrade];
        simPoints += pts * credits;
        simGradedCredits += credits;
        simModulesCount++;
      }
    });

    // 4. Calcul du GPA Global (Officiel + Modules simulés)
    let simulatedGpa = officialGpa;
    let deltaGpa = 0;

    if (officialGpa !== null && !isNaN(officialGpa)) {
      const pastPoints = officialGpa * pastAcquiredCredits;
      if (simGradedCredits > 0) {
        const totalSimCredits = pastAcquiredCredits + simGradedCredits;
        simulatedGpa = totalSimCredits > 0 ? ((pastPoints + simPoints) / totalSimCredits) : officialGpa;
        deltaGpa = simulatedGpa - officialGpa;
      } else {
        simulatedGpa = officialGpa;
        deltaGpa = 0;
      }
    } else if (simGradedCredits > 0) {
      simulatedGpa = simPoints / simGradedCredits;
      deltaGpa = null;
    }

    return {
      officialGpa,
      simulatedGpa,
      deltaGpa,
      pastAcquiredCredits,
      simGradedCredits,
      simModulesCount
    };
  }

  function findAcademicNavBar() {
    const overviewBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent && (
        b.textContent.includes("Vue d'ensemble") ||
        b.textContent.includes("Compétences") ||
        b.textContent.includes("Évaluations") ||
        b.textContent.includes("Documents")
      )
    );
    if (overviewBtn && overviewBtn.parentElement) {
      return overviewBtn.parentElement;
    }

    return document.querySelector('.mantine-visible-from-sm[style*="grid-template-columns"]')
      || document.querySelector('.mantine-visible-from-sm')
      || document.querySelector('.mantine-Tabs-tabsList, .mantine-Tabs-list, [role="tablist"]');
  }

  function cleanUpGpaSimulator() {
    const tabBtn = document.getElementById('myepitech-gpa-tab-btn');
    if (tabBtn) tabBtn.remove();
    const trigger = document.getElementById('myepitech-gpa-floating-trigger');
    if (trigger) trigger.remove();
    const panel = document.getElementById('myepitech-gpa-simulator-container');
    if (panel) panel.remove();

    document.querySelectorAll('.myepitech-gpa-tabs-active').forEach((el) => el.classList.remove('myepitech-gpa-tabs-active'));
    document.querySelectorAll('[data-gpa-hidden="true"]').forEach((el) => {
      el.removeAttribute('data-gpa-hidden');
      el.style.display = '';
    });

    isGpaTabActive = false;
  }

  /**
   * L'état visuel des onglets passe uniquement par la classe `myepitech-gpa-tabs-active` posée sur la barre
   * (voir content.css) : les onglets natifs, gérés par React, ne sont jamais modifiés directement.
   */
  function deactivateGpaTab() {
    isGpaTabActive = false;
    const tabBtn = document.getElementById('myepitech-gpa-tab-btn');
    if (tabBtn) {
      tabBtn.classList.remove('active');
      tabBtn.removeAttribute('aria-current');
    }

    document.querySelectorAll('.myepitech-gpa-tabs-active').forEach((el) => el.classList.remove('myepitech-gpa-tabs-active'));

    const panel = document.getElementById('myepitech-gpa-simulator-container');
    if (panel) panel.style.display = 'none';

    document.querySelectorAll('[data-gpa-hidden="true"]').forEach((el) => {
      el.removeAttribute('data-gpa-hidden');
      el.style.display = '';
    });
  }

  function activateGpaTab() {
    isGpaTabActive = true;
    const navBar = findAcademicNavBar();

    if (navBar) navBar.classList.add('myepitech-gpa-tabs-active');

    const tabBtn = document.getElementById('myepitech-gpa-tab-btn');
    if (tabBtn) {
      tabBtn.classList.add('active');
      tabBtn.setAttribute('aria-current', 'page');
    }

    const stack = navBar ? navBar.parentElement : document.querySelector('.mantine-AppShell-main');
    if (stack) {
      Array.from(stack.children).forEach((child) => {
        if (child !== navBar && !child.classList.contains('myepitech-gpa-simulator-panel') && !child.id.includes('gpa')) {
          child.setAttribute('data-gpa-hidden', 'true');
          child.style.display = 'none';
        }
      });
    }

    let panel = document.getElementById('myepitech-gpa-simulator-container');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'myepitech-gpa-simulator-container';
      panel.className = 'myepitech-gpa-simulator-panel';
      if (navBar) {
        navBar.after(panel);
      } else if (stack) {
        stack.appendChild(panel);
      } else {
        document.body.appendChild(panel);
      }
    }
    panel.style.display = 'block';

    if (!academicDataCache || !academicDataCache.validations) {
      requestAcademicData(currentSelectedSemesterId);
    }
    renderGpaSimulator();
  }

  function getGradeClass(grade) {
    if (grade === 'A') return 'grade-A';
    if (grade === 'B') return 'grade-B';
    if (grade === 'C') return 'grade-C';
    if (grade === 'D') return 'grade-D';
    if (grade === 'E' || grade === 'Fail') return 'grade-Fail';
    return 'grade-none';
  }

  /**
   * Pastilles des modules (code + lien vers la fiche) qui alimentent un bloc UE
   */
  function renderModuleChips(entry) {
    const modules = (entry && entry.modules) || [];
    if (modules.length === 0) {
      const text = entry && entry.transversal ? 'UE transversale (plusieurs modules)' : 'Aucun module inscrit rattaché';
      return `<span class="myepitech-gpa-module-none">${text}</span>`;
    }
    return modules.map((mod) => {
      const title = escapeHtml(mod.inferred ? 'Module rapproché par le nom (non officiel)' : 'Ouvrir la fiche du module');
      const label = `<strong>${escapeHtml(mod.unitCode)}</strong> ${escapeHtml(mod.name)}`;

      if (!mod.schoolYear || !mod.instanceCode) {
        return `<span class="myepitech-module-chip" title="${title}">${label}</span>`;
      }
      const href = `/units/${encodeURIComponent(mod.schoolYear)}/${encodeURIComponent(mod.unitCode)}/${encodeURIComponent(mod.instanceCode)}`;
      return `<a class="myepitech-module-chip" href="${href}" title="${title}">${label}</a>`;
    }).join('');
  }

  function renderGpaSimulator() {
    const panel = document.getElementById('myepitech-gpa-simulator-container');
    if (!panel || !isGpaTabActive) return;

    if (academicDataLoading && (!academicDataCache || !academicDataCache.validations)) {
      panel.innerHTML = `
        <div class="myepitech-gpa-loading">
          <div class="myepitech-gpa-spinner"></div>
          <div>Chargement des modules et du parcours académique...</div>
        </div>
      `;
      return;
    }

    if (academicDataError || !academicDataCache || !academicDataCache.validations) {
      const errMsg = academicDataError || 'Impossible de récupérer automatiquement les modules et les validations.';
      panel.innerHTML = `
        <div class="myepitech-gpa-error mantine-Paper-root">
          <div class="myepitech-gpa-error-title">Chargement des données</div>
          <div class="myepitech-gpa-error-msg">${escapeHtml(errMsg)}</div>
          <div class="myepitech-gpa-error-actions">
            <button type="button" id="myepitech-gpa-retry-btn" class="myepitech-gpa-retry-btn">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;display:inline-block;vertical-align:-2px;"><path d="M20 11A8.1 8.1 0 0 0 4.5 9M4 5v4h4m-4 4a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/></svg>
              <span>Réessayer</span>
            </button>
          </div>
        </div>
      `;
      const retryBtn = panel.querySelector('#myepitech-gpa-retry-btn');
      if (retryBtn) {
        retryBtn.addEventListener('click', () => {
          panel.innerHTML = `
            <div class="myepitech-gpa-loading">
              <div class="myepitech-gpa-spinner"></div>
              <div>Tentative de reconnexion...</div>
            </div>
          `;
          requestAcademicData(currentSelectedSemesterId, true);
        });
      }
      return;
    }

    const modules = getEnrolledModulesList();
    const stats = calculateGpaStats();
    const blockModules = academicDataCache.blockModules || {};

    const semName = academicDataCache.validations.semester ? `Semestre B${academicDataCache.validations.semester}` : 'Semestre Actuel';
    const attendedSemesters = academicDataCache.validations.attendedSemesters || [];

    let deltaBadgeHtml = '';
    if (stats.deltaGpa !== null && stats.simGradedCredits > 0) {
      const deltaSign = stats.deltaGpa > 0 ? `+${stats.deltaGpa.toFixed(2)}` : stats.deltaGpa.toFixed(2);
      const deltaClass = stats.deltaGpa > 0 ? 'delta-positive' : (stats.deltaGpa < 0 ? 'delta-negative' : 'delta-neutral');
      deltaBadgeHtml = `<span class="myepitech-gpa-delta-badge ${deltaClass}">${deltaSign}</span>`;
    }

    panel.innerHTML = `
      <div class="myepitech-gpa-header">
        <div class="myepitech-gpa-title-area">
          <h2 class="myepitech-gpa-title">Simulateur GPA</h2>
          <span class="myepitech-gpa-semester-badge">${semName}</span>
        </div>
        <div class="myepitech-gpa-header-actions">
          ${stats.simModulesCount > 0 ? `
            <button type="button" id="myepitech-gpa-reset-btn" class="myepitech-preset-btn reset" title="Réinitialiser tous les grades simulés">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;display:inline-block;vertical-align:-2px;"><path d="M20 11A8.1 8.1 0 0 0 4.5 9M4 5v4h4m-4 4a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/></svg>
              <span>Réinitialiser la simulation</span>
            </button>
          ` : ''}
          ${attendedSemesters.length > 0 ? `
            <select id="myepitech-gpa-semester-select" class="myepitech-gpa-select" title="Changer de semestre">
              ${attendedSemesters.map((s) => `
                <option value="${s.semesterId}" ${String(s.semesterId) === String(currentSelectedSemesterId || academicDataCache.validations.viewedSemesterId || academicDataCache.validations.semesterId) ? 'selected' : ''}>
                  Semestre ${s.semesterNum || s.semester || ''} (${s.schoolYear})
                </option>
              `).join('')}
            </select>
          ` : ''}
          <button id="myepitech-gpa-refresh-btn" class="myepitech-gpa-btn-icon" title="Actualiser les données">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;display:inline-block;vertical-align:-2px;"><path d="M20 11A8.1 8.1 0 0 0 4.5 9M4 5v4h4m-4 4a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/></svg>
            <span>Actualiser</span>
          </button>
        </div>
      </div>

      <!-- Cartes KPI : GPA Global uniquement -->
      <div class="myepitech-gpa-kpis myepitech-gpa-kpis-compact">
        <div class="myepitech-gpa-kpi-card mantine-Paper-root">
          <div class="myepitech-gpa-kpi-label">GPA Global Actuel</div>
          <div class="myepitech-gpa-kpi-val">${stats.officialGpa !== null ? stats.officialGpa.toFixed(2) : '--'}</div>
          <div class="myepitech-gpa-kpi-sub">Officiel My Epitech (${stats.pastAcquiredCredits} ECTS acquis)</div>
        </div>

        <div class="myepitech-gpa-kpi-card mantine-Paper-root highlight">
          <div class="myepitech-gpa-kpi-label">GPA Global Simulé</div>
          <div class="myepitech-gpa-kpi-val accent">${stats.simulatedGpa !== null ? stats.simulatedGpa.toFixed(2) : '--'} ${deltaBadgeHtml}</div>
          <div class="myepitech-gpa-kpi-sub">${stats.simModulesCount > 0 ? `${stats.simModulesCount} module(s) simulé(s) (+${stats.simGradedCredits} ECTS)` : 'Déroulez les grades ci-dessous pour simuler'}</div>
        </div>
      </div>

      <!-- Tableau interactif épuré -->
      <div class="myepitech-gpa-table-wrapper mantine-Paper-root">
        <table class="myepitech-gpa-table">
          <thead>
            <tr>
              <th style="width: 58%;">Module & Intitulé</th>
              <th style="width: 18%; text-align: center;">ECTS</th>
              <th style="width: 24%; text-align: center;">Grade</th>
            </tr>
          </thead>
          <tbody>
            ${modules.length === 0 ? `
              <tr>
                <td colspan="3" class="myepitech-gpa-empty">Aucun module inscrit détecté pour ce semestre.</td>
              </tr>
            ` : modules.map((m) => {
              const credits = Number(m.credits) || 0;
              let simGrade = simulatedGradesState[m.id];
              if (simGrade === undefined) {
                simGrade = '-';
              }

              return `
                <tr class="myepitech-gpa-row ${simGrade !== '-' ? 'graded-row' : ''}">
                  <td>
                    <div class="myepitech-gpa-module-code">${escapeHtml(m.title || 'UE')}</div>
                    <div class="myepitech-gpa-module-name">${escapeHtml(m.titleFr || m.title || '')}</div>
                    <div class="myepitech-gpa-module-links">${renderModuleChips(blockModules[m.id])}</div>
                  </td>
                  <td style="text-align: center;">
                    <span class="myepitech-ects-badge">${credits} ECTS</span>
                  </td>
                  <td style="text-align: center;">
                    <select class="myepitech-grade-select ${getGradeClass(simGrade)}" data-module-id="${m.id}" title="Choisir un grade pour simuler">
                      <option value="-" ${simGrade === '-' ? 'selected' : ''}>-</option>
                      <option value="A" ${simGrade === 'A' ? 'selected' : ''}>A</option>
                      <option value="B" ${simGrade === 'B' ? 'selected' : ''}>B</option>
                      <option value="C" ${simGrade === 'C' ? 'selected' : ''}>C</option>
                      <option value="D" ${simGrade === 'D' ? 'selected' : ''}>D</option>
                      <option value="E" ${simGrade === 'E' || simGrade === 'Fail' ? 'selected' : ''}>E</option>
                    </select>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;

    attachSimulatorEventListeners(panel);
  }

  function attachSimulatorEventListeners(panel) {
    // Sélecteurs de grade déroulants
    panel.querySelectorAll('.myepitech-grade-select').forEach((sel) => {
      sel.addEventListener('change', (e) => {
        const modId = e.target.getAttribute('data-module-id');
        const grade = e.target.value;
        if (modId) {
          if (grade === '-') {
            delete simulatedGradesState[modId];
          } else {
            simulatedGradesState[modId] = grade;
          }
          renderGpaSimulator();
        }
      });
    });

    // Bouton de réinitialisation de la simulation
    const resetBtn = panel.querySelector('#myepitech-gpa-reset-btn');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        simulatedGradesState = {};
        renderGpaSimulator();
      });
    }

    // Sélecteur de semestre
    const semSelect = panel.querySelector('#myepitech-gpa-semester-select');
    if (semSelect) {
      semSelect.addEventListener('change', (e) => {
        const semId = e.target.value;
        currentSelectedSemesterId = semId;
        simulatedGradesState = {};
        panel.innerHTML = `
          <div class="myepitech-gpa-loading">
            <div class="myepitech-gpa-spinner"></div>
            <div>Chargement du semestre sélectionné...</div>
          </div>
        `;
        requestAcademicData(semId);
      });
    }

    // Bouton de rafraîchissement
    const refreshBtn = panel.querySelector('#myepitech-gpa-refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        panel.innerHTML = `
          <div class="myepitech-gpa-loading">
            <div class="myepitech-gpa-spinner"></div>
            <div>Actualisation des données en cours...</div>
          </div>
        `;
        requestAcademicData(currentSelectedSemesterId, true);
      });
    }
  }

  function initAcademicPage() {
    if (!isAcademicPage()) return;

    const navBar = findAcademicNavBar();
    if (navBar && !document.getElementById('myepitech-gpa-tab-btn')) {
      const currentStyle = navBar.getAttribute('style') || '';
      if (currentStyle.includes('grid-template-columns')) {
        navBar.style.gridTemplateColumns = 'repeat(auto-fit, minmax(115px, 1fr))';
      }

      const tabBtn = document.createElement('button');
      tabBtn.type = 'button';
      tabBtn.id = 'myepitech-gpa-tab-btn';
      tabBtn.className = 'mantine-focus-auto m_87cf2631 mantine-UnstyledButton-root myepitech-gpa-nav-btn';
      tabBtn.innerHTML = `<span>Simulateur GPA</span>`;

      tabBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (isGpaTabActive) {
          deactivateGpaTab();
        } else {
          activateGpaTab();
        }
      });

      navBar.appendChild(tabBtn);

      // La barre survit à la recréation du bouton : un seul écouteur suffit
      if (!navBar.dataset.myepitechGpaListener) {
        navBar.dataset.myepitechGpaListener = 'true';
        navBar.addEventListener('click', (e) => {
          if (!e.target.closest('#myepitech-gpa-tab-btn')) {
            deactivateGpaTab();
          }
        });
      }
    }

    if (!academicDataCache) {
      requestAcademicData(null, false);
    }
  }

  /**
   * Surveillance des navigations SPA (React Router) et des modifications du DOM
   */
  function setupNavigationObserver() {
    let oldHref = window.location.href;

    const checkUrlChange = () => {
      if (window.location.href !== oldHref) {
        oldHref = window.location.href;
        if (!isProjectsPage()) {
          cleanUpProjectsElements();
        }
        if (!isAcademicPage()) {
          cleanUpGpaSimulator();
        }

        if (isUnitsPage()) {
          setTimeout(() => restorePreferences(true), 300);
        } else if (isProjectsPage()) {
          setTimeout(() => {
            initProjectsPage();
          }, 200);
        } else if (isAcademicPage()) {
          setTimeout(() => {
            initAcademicPage();
          }, 200);
        }
      }
    };

    // pushState/replaceState sont interceptés par bridge.js (monde MAIN), qui émet __MYEPITECH_ROUTE_CHANGE__
    window.addEventListener('popstate', checkUrlChange);
    window.addEventListener('__MYEPITECH_ROUTE_CHANGE__', checkUrlChange);

    // Observateur pour détecter l'apparition du tableau et les cartes de projets
    let domDebounce = null;
    const pageObserver = new MutationObserver((mutations) => {
      // Ignorer les mutations générées par nos propres éléments
      const isInternal = mutations.every((m) => {
        const t = m.target;
        return t && t.closest && (
          t.closest('.myepitech-projects-filter-bar') ||
          t.closest('.myepitech-project-code-badge') ||
          t.closest('.myepitech-enroll-badge') ||
          t.closest('.myepitech-toast-container') ||
          t.closest('.myepitech-gpa-simulator-panel') ||
          t.closest('.myepitech-gpa-tab') ||
          (t.classList && t.classList.contains('myepitech-project-card-hidden'))
        );
      });
      if (isInternal) return;

      if (domDebounce) clearTimeout(domDebounce);
      domDebounce = setTimeout(async () => {
        const settings = await getSettings();
        if (!settings.enabled) return;

        if (!isProjectsPage()) {
          cleanUpProjectsElements();
        }
        if (!isAcademicPage()) {
          cleanUpGpaSimulator();
        }

        if (isUnitsPage() && !isApplying) {
          const paginator = document.querySelector('input[aria-labelledby="rpp-label"]');
          if (paginator && lastAppliedUrl !== window.location.href) {
            restorePreferences();
          }
          if (settings.showBadges !== false) {
            updateEnrollmentBadges(true);
          }
        } else if (isProjectsPage()) {
          autoExpandShowMore();
          if (settings.showProjectCodes !== false) {
            updateProjectModuleCodes(true);
          }
          updateProjectsFilterBar();
        } else if (isAcademicPage()) {
          if (settings.showGpaSimulator !== false) {
            initAcademicPage();
          }
        }
      }, 100);
    });

    pageObserver.observe(document.body, { childList: true, subtree: true });
  }

  /**
   * Communication avec la popup de l'extension
   */
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'ping') {
      sendResponse({
        status: 'ok',
        isUnitsPage: isUnitsPage(),
        isProjectsPage: isProjectsPage(),
        isAcademicPage: isAcademicPage()
      });
      return true;
    }

    if (message.action === 'apply_now') {
      if (isUnitsPage()) {
        restorePreferences(true).then(() => {
          sendResponse({ success: true });
        });
      } else if (isProjectsPage()) {
        initProjectsPage();
        sendResponse({ success: true });
      } else if (isAcademicPage()) {
        initAcademicPage();
        sendResponse({ success: true });
      }
      return true;
    }

    if (message.action === 'update_badges') {
      updateEnrollmentBadges(Boolean(message.showBadges));
      sendResponse({ success: true });
      return true;
    }

    if (message.action === 'update_project_codes') {
      updateProjectModuleCodes(Boolean(message.showProjectCodes));
      sendResponse({ success: true });
      return true;
    }

    if (message.action === 'update_project_filter') {
      getSettings().then(async (settings) => {
        settings.filterEnrolledProjectsOnly = Boolean(message.filterEnrolledOnly);
        await saveSettings(settings);
        await updateProjectsFilterBar();
        sendResponse({ success: true });
      });
      return true;
    }

    if (message.action === 'update_hide_user_name') {
      applyUserNameVisibility(Boolean(message.hideUserName));
      sendResponse({ success: true });
      return true;
    }

    if (message.action === 'update_gpa_simulator') {
      getSettings().then(async (settings) => {
        settings.showGpaSimulator = Boolean(message.showGpaSimulator);
        await saveSettings(settings);
        if (isAcademicPage()) {
          if (settings.showGpaSimulator) {
            initAcademicPage();
          } else {
            cleanUpGpaSimulator();
          }
        }
        sendResponse({ success: true });
      });
      return true;
    }

    // Pas d'autre action
  });

  // Initialisation
  setupUserChangeListeners();
  setupNavigationObserver();

  const init = async () => {
    const settings = await getSettings();
    if (!settings.enabled) {
      applyUserNameVisibility(false);
      return;
    }

    applyUserNameVisibility(settings.hideUserName);

    if (!isProjectsPage()) {
      cleanUpProjectsElements();
    }
    if (!isAcademicPage()) {
      cleanUpGpaSimulator();
    }

    if (isUnitsPage()) {
      restorePreferences(true);
    } else if (isProjectsPage()) {
      initProjectsPage();
    } else if (isAcademicPage()) {
      if (settings.showGpaSimulator !== false) {
        initAcademicPage();
      }
    }

    // Nettoyer tout ancien cache résiduel de marque
    try {
      chrome.storage?.local?.remove(['myepitech_brand_cache']);
    } catch (e) {}
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
