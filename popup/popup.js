/**
 * MyEpitech Enhancer - Popup Script
 */

const STORAGE_KEY = 'myepitech_modules_settings';

const DEFAULT_SETTINGS = {
  enabled: true,
  hideUserName: false,
  showBadges: true,
  showProjectCodes: true,
  filterEnrolledProjectsOnly: false,
  showGpaSimulator: true,
  rowsPerPage: '50',
  columns: {
    'Code': true,
    'Nom': true,
    'Semestre': true,
    'Campus': true,
    'Date de début': true,
    'Date de fin': true,
    'Actions': true
  }
};

const KNOWN_COLUMNS = [
  'Code',
  'Nom',
  'Semestre',
  'Campus',
  'Date de début',
  'Date de fin',
  'Actions'
];

let currentSettings = { ...DEFAULT_SETTINGS };

async function getStorage() {
  return new Promise((resolve) => {
    const storage = chrome.storage.sync || chrome.storage.local;
    storage.get([STORAGE_KEY], (res) => {
      if (chrome.runtime.lastError) {
        chrome.storage.local.get([STORAGE_KEY], (localRes) => {
          resolve(localRes && localRes[STORAGE_KEY] ? { ...DEFAULT_SETTINGS, ...localRes[STORAGE_KEY] } : DEFAULT_SETTINGS);
        });
      } else {
        resolve(res && res[STORAGE_KEY] ? { ...DEFAULT_SETTINGS, ...res[STORAGE_KEY] } : DEFAULT_SETTINGS);
      }
    });
  });
}

async function setStorage(settings) {
  return new Promise((resolve) => {
    const storage = chrome.storage.sync || chrome.storage.local;
    storage.set({ [STORAGE_KEY]: settings }, () => {
      if (chrome.runtime.lastError) {
        chrome.storage.local.set({ [STORAGE_KEY]: settings }, resolve);
      } else {
        resolve();
      }
    });
  });
}

// Initialisation UI
document.addEventListener('DOMContentLoaded', async () => {
  currentSettings = await getStorage();

  const toggleEnabled = document.getElementById('toggle-enabled');
  const toggleBadges = document.getElementById('toggle-badges');
  const toggleProjectCodes = document.getElementById('toggle-project-codes');
  const toggleFilterEnrolled = document.getElementById('toggle-filter-enrolled');
  const toggleHideUserName = document.getElementById('toggle-hide-user-name');
  const toggleGpaSimulator = document.getElementById('toggle-gpa-simulator');
  const selectRows = document.getElementById('select-rows');
  const columnsList = document.getElementById('columns-list');
  const btnSelectAll = document.getElementById('btn-select-all');
  const btnApplyNow = document.getElementById('btn-apply-now');
  const btnReset = document.getElementById('btn-reset');
  const statusBanner = document.getElementById('status-banner');
  const statusText = document.getElementById('status-text');

  // Remplir les inputs avec les valeurs
  toggleEnabled.checked = currentSettings.enabled !== false;
  if (toggleBadges) {
    toggleBadges.checked = currentSettings.showBadges !== false;
  }
  if (toggleProjectCodes) {
    toggleProjectCodes.checked = currentSettings.showProjectCodes !== false;
  }
  if (toggleFilterEnrolled) {
    toggleFilterEnrolled.checked = Boolean(currentSettings.filterEnrolledProjectsOnly);
  }
  if (toggleHideUserName) {
    toggleHideUserName.checked = Boolean(currentSettings.hideUserName);
  }
  if (toggleGpaSimulator) {
    toggleGpaSimulator.checked = currentSettings.showGpaSimulator !== false;
  }
  selectRows.value = currentSettings.rowsPerPage || '50';

  // Générer la liste des colonnes
  renderColumns(columnsList);

  // Nettoyer tout ancien cache de marque (pour éviter l'injection de l'icône de cloche du site)
  try {
    chrome.storage.local.remove(['myepitech_brand_cache']);
  } catch (e) {}

  // Vérifier l'état de l'onglet actif et allumer l'indicateur vert
  let isConnected = false;
  let detectedTitle = 'Connecté à My Epitech';

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab) {
    if (activeTab.url && activeTab.url.includes('my.epitech.eu')) {
      isConnected = true;
      try {
        const url = new URL(activeTab.url);
        const p = url.pathname;
        if (p === '/projects' || p === '/projects/') {
          detectedTitle = 'Connecté aux Projets';
        } else if (p.startsWith('/units') && !p.includes('/projects/')) {
          detectedTitle = 'Connecté aux Modules';
        } else if (p.includes('/me/academic')) {
          detectedTitle = 'Parcours Académique (Simulateur GPA)';
        } else if (p.includes('/projects/')) {
          detectedTitle = 'Fiche détaillée de projet';
        } else {
          detectedTitle = 'Connecté à My Epitech';
        }
      } catch (e) {
        detectedTitle = 'Connecté à My Epitech';
      }
    } else {
      // Fallback si l'URL est restreinte : tester la réponse du content script
      try {
        const ping = await chrome.tabs.sendMessage(activeTab.id, { action: 'ping' });
        if (ping && ping.status === 'ok') {
          isConnected = true;
          if (ping.isProjectsPage) detectedTitle = 'Connecté aux Projets';
          else if (ping.isUnitsPage) detectedTitle = 'Connecté aux Modules';
          else if (ping.isAcademicPage) detectedTitle = 'Parcours Académique (Simulateur GPA)';
          else detectedTitle = 'Connecté à My Epitech';
        }
      } catch (e) {}
    }
  }

  if (isConnected) {
    statusBanner.classList.add('active');
    statusText.textContent = detectedTitle;
  } else {
    statusBanner.classList.remove('active');
    statusText.textContent = 'Hors de My Epitech';
  }

  // Événements
  toggleEnabled.addEventListener('change', async () => {
    currentSettings.enabled = toggleEnabled.checked;
    await setStorage(currentSettings);
  });

  if (toggleBadges) {
    toggleBadges.addEventListener('change', async () => {
      currentSettings.showBadges = toggleBadges.checked;
      await setStorage(currentSettings);
      if (activeTab && activeTab.id) {
        try {
          await chrome.tabs.sendMessage(activeTab.id, {
            action: 'update_badges',
            showBadges: currentSettings.showBadges
          });
        } catch (e) {}
      }
    });
  }

  if (toggleProjectCodes) {
    toggleProjectCodes.addEventListener('change', async () => {
      currentSettings.showProjectCodes = toggleProjectCodes.checked;
      await setStorage(currentSettings);
      if (activeTab && activeTab.id) {
        try {
          await chrome.tabs.sendMessage(activeTab.id, {
            action: 'update_project_codes',
            showProjectCodes: currentSettings.showProjectCodes
          });
        } catch (e) {}
      }
    });
  }

  if (toggleFilterEnrolled) {
    toggleFilterEnrolled.addEventListener('change', async () => {
      currentSettings.filterEnrolledProjectsOnly = toggleFilterEnrolled.checked;
      await setStorage(currentSettings);
      if (activeTab && activeTab.id) {
        try {
          await chrome.tabs.sendMessage(activeTab.id, {
            action: 'update_project_filter',
            filterEnrolledOnly: currentSettings.filterEnrolledProjectsOnly
          });
        } catch (e) {
          if (statusText) statusText.textContent = 'Rechargez l\'onglet (F5) pour synchroniser';
        }
      }
    });
  }

  if (toggleHideUserName) {
    toggleHideUserName.addEventListener('change', async () => {
      currentSettings.hideUserName = toggleHideUserName.checked;
      await setStorage(currentSettings);
      if (activeTab && activeTab.id) {
        try {
          await chrome.tabs.sendMessage(activeTab.id, {
            action: 'update_hide_user_name',
            hideUserName: currentSettings.hideUserName
          });
        } catch (e) {
          if (statusText) statusText.textContent = 'Rechargez l\'onglet (F5) pour synchroniser';
        }
      }
    });
  }

  if (toggleGpaSimulator) {
    toggleGpaSimulator.addEventListener('change', async () => {
      currentSettings.showGpaSimulator = toggleGpaSimulator.checked;
      await setStorage(currentSettings);
      if (activeTab && activeTab.id) {
        try {
          await chrome.tabs.sendMessage(activeTab.id, {
            action: 'update_gpa_simulator',
            showGpaSimulator: currentSettings.showGpaSimulator
          });
        } catch (e) {
          if (statusText) statusText.textContent = 'Rechargez l\'onglet (F5) pour synchroniser';
        }
      }
    });
  }

  selectRows.addEventListener('change', async () => {
    currentSettings.rowsPerPage = selectRows.value;
    await setStorage(currentSettings);
  });

  btnSelectAll.addEventListener('click', async () => {
    const allChecked = KNOWN_COLUMNS.every((col) => currentSettings.columns[col] !== false);
    const newState = !allChecked;

    KNOWN_COLUMNS.forEach((col) => {
      currentSettings.columns[col] = newState;
    });

    btnSelectAll.textContent = newState ? 'Tout décocher' : 'Tout cocher';
    renderColumns(columnsList);
    await setStorage(currentSettings);
  });

  btnApplyNow.addEventListener('click', async () => {
    if (!activeTab || !activeTab.id) return;

    btnApplyNow.disabled = true;
    const origHtml = btnApplyNow.innerHTML;
    btnApplyNow.innerHTML = '<span>Application...</span>';

    try {
      await chrome.tabs.sendMessage(activeTab.id, { action: 'apply_now' });
      btnApplyNow.innerHTML = `
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        <span>Appliqué</span>
      `;
    } catch (err) {
      btnApplyNow.innerHTML = '<span>Rechargez (F5)</span>';
      if (statusText) statusText.textContent = 'Rechargez l\'onglet My Epitech (F5) pour synchroniser';
    }

    setTimeout(() => {
      btnApplyNow.disabled = false;
      btnApplyNow.innerHTML = origHtml;
    }, 1200);
  });

  btnReset.addEventListener('click', async () => {
    if (confirm('Voulez-vous réinitialiser les réglages par défaut (50 lignes, toutes colonnes actives, badges et codes actifs) ?')) {
      currentSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
      await setStorage(currentSettings);
      toggleEnabled.checked = true;
      if (toggleBadges) toggleBadges.checked = true;
      if (toggleProjectCodes) toggleProjectCodes.checked = true;
      if (toggleFilterEnrolled) toggleFilterEnrolled.checked = false;
      if (toggleHideUserName) toggleHideUserName.checked = false;
      if (toggleGpaSimulator) toggleGpaSimulator.checked = true;
      selectRows.value = '50';
      renderColumns(columnsList);
      if (activeTab && activeTab.id) {
        try {
          await chrome.tabs.sendMessage(activeTab.id, {
            action: 'update_hide_user_name',
            hideUserName: false
          });
        } catch (e) {}
      }
    }
  });
});

function renderColumns(container) {
  container.innerHTML = '';

  KNOWN_COLUMNS.forEach((col) => {
    const isChecked = currentSettings.columns[col] !== false;

    const label = document.createElement('label');
    label.className = 'col-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = isChecked;

    checkbox.addEventListener('change', async () => {
      currentSettings.columns[col] = checkbox.checked;
      await setStorage(currentSettings);
    });

    const span = document.createElement('span');
    span.textContent = col;
    span.title = col;

    label.appendChild(checkbox);
    label.appendChild(span);
    container.appendChild(label);
  });
}
