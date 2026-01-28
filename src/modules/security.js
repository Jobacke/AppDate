
const SALT = "AppDate-Secure-Salt-v1";
const STORAGE_KEY = 'appDate_pinHash';

// State
let currentPinInput = [];
let modalMode = 'none'; // 'setup', 'remove-verify', 'change-verify-old', 'change-new'
let tempPin = null; // To store intermediate PIN during change process

// Exports to Window for HTML interaction
export function initSecurity() {
    // Expose functions to window
    window.openSecuritySettings = openSecuritySettings;
    window.closeSecurityModal = closeSecurityModal;
    window.startPinSetup = startPinSetup;
    window.startPinChange = startPinChange;
    window.startPinRemoval = startPinRemoval;
    window.confirmPinAction = confirmPinAction;
    window.cancelPinAction = cancelPinAction;
    window.clearPinDigit = clearPinDigit;

    // Bind Keypad clicks (using data attributes)
    document.querySelectorAll('.pin-key').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const digit = e.target.getAttribute('data-num');
            if (digit) handlePinDigit(digit);
        });
    });

    // Check Lock State
    if (hasPin()) {
        showLockScreen();
    } else {
        // App is open
    }
}

// --- Lock Screen Logic ---

function showLockScreen() {
    const lockScreen = document.getElementById('lockScreen');
    lockScreen.classList.remove('hidden');
    lockScreen.classList.add('flex');
    currentPinInput = [];
    updatePinDisplay();
}

function hideLockScreen() {
    const lockScreen = document.getElementById('lockScreen');
    lockScreen.classList.add('hidden');
    lockScreen.classList.remove('flex');
    currentPinInput = [];
}

async function handlePinDigit(digit) {
    if (currentPinInput.length < 4) {
        currentPinInput.push(digit);
        updatePinDisplay();

        if (currentPinInput.length === 4) {
            // Check PIN
            await verifyLockScreenPin();
        }
    }
}

function clearPinDigit() {
    if (currentPinInput.length > 0) {
        currentPinInput.pop();
        updatePinDisplay();
    }
    document.getElementById('lockMessage').textContent = '';
}

function updatePinDisplay() {
    const dots = document.getElementById('pinDisplayDots').children;
    for (let i = 0; i < 4; i++) {
        if (i < currentPinInput.length) {
            dots[i].classList.remove('bg-br-700', 'border-br-600');
            dots[i].classList.add('bg-blue-500', 'border-blue-400', 'shadow-[0_0_10px_rgba(59,130,246,0.5)]');
        } else {
            dots[i].classList.remove('bg-blue-500', 'border-blue-400', 'shadow-[0_0_10px_rgba(59,130,246,0.5)]');
            dots[i].classList.add('bg-br-700', 'border-br-600');
        }
    }
}

async function verifyLockScreenPin() {
    const enteredPin = currentPinInput.join('');
    const isValid = await checkPin(enteredPin);

    if (isValid) {
        // Success
        hideLockScreen();
    } else {
        // Fail
        showLockError('Falscher PIN');
        // Shake animation
        const dotsContainer = document.getElementById('pinDisplayDots');
        dotsContainer.classList.add('animate-shake'); // creating this class later or using inline style

        setTimeout(() => {
            currentPinInput = [];
            updatePinDisplay();
            dotsContainer.classList.remove('animate-shake');
        }, 500);
    }
}

function showLockError(msg) {
    document.getElementById('lockMessage').textContent = msg;
}


// --- Modal / Settings Logic ---

function openSecuritySettings() {
    const modal = document.getElementById('securityModal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');

    resetModalView();
}

function closeSecurityModal() {
    const modal = document.getElementById('securityModal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    resetModalView();
}

function resetModalView() {
    document.getElementById('securityMainView').classList.remove('hidden');
    document.getElementById('securityPinView').classList.add('hidden');
    document.getElementById('modalPinInput').value = '';
    document.getElementById('modalPinError').textContent = '';
    modalMode = 'none';

    if (hasPin()) {
        document.getElementById('pinManageSection').classList.remove('hidden');
        document.getElementById('pinSetupSection').classList.add('hidden');
    } else {
        document.getElementById('pinManageSection').classList.add('hidden');
        document.getElementById('pinSetupSection').classList.remove('hidden');
    }
}

function showPinView(title, desc, mode) {
    document.getElementById('securityMainView').classList.add('hidden');
    document.getElementById('securityPinView').classList.remove('hidden');
    document.getElementById('securityPinView').classList.add('flex');

    document.getElementById('pinViewTitle').textContent = title;
    document.getElementById('pinViewDesc').textContent = desc;

    document.getElementById('modalPinInput').value = '';
    document.getElementById('modalPinInput').focus();

    modalMode = mode;
}

function startPinSetup() {
    showPinView('PIN erstellen', 'Bitte 4-stelligen Code eingeben', 'setup');
}

function startPinChange() {
    showPinView('Authentifizierung', 'Alten PIN eingeben', 'change-verify-old');
}

function startPinRemoval() {
    showPinView('Authentifizierung', 'Bitte PIN zur Bestätigung eingeben', 'remove-verify');
}

function cancelPinAction() {
    resetModalView();
}

async function confirmPinAction() {
    const input = document.getElementById('modalPinInput').value;
    const errorEl = document.getElementById('modalPinError');

    if (!/^\d{4}$/.test(input)) {
        errorEl.textContent = 'Muss genau 4 Zahlen enthalten.';
        return;
    }

    if (modalMode === 'setup') {
        await savePin(input);
        closeSecurityModal();
        alert('PIN erfolgreich eingerichtet!');
    } else if (modalMode === 'remove-verify') {
        if (await checkPin(input)) {
            removePin();
            closeSecurityModal();
            alert('PIN entfernt.');
        } else {
            errorEl.textContent = 'Falscher PIN.';
        }
    } else if (modalMode === 'change-verify-old') {
        if (await checkPin(input)) {
            showPinView('Neuer PIN', 'Bitte neuen Code eingeben', 'change-new');
        } else {
            errorEl.textContent = 'Falscher PIN.';
        }
    } else if (modalMode === 'change-new') {
        await savePin(input);
        closeSecurityModal();
        alert('PIN erfolgreich geändert!');
    }
}


// --- Crypto / Storage Helpers ---

function hasPin() {
    return !!localStorage.getItem(STORAGE_KEY);
}

async function hashPin(pin) {
    const msgBuffer = new TextEncoder().encode(pin + SALT);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function savePin(pin) {
    const hash = await hashPin(pin);
    localStorage.setItem(STORAGE_KEY, hash);
}

async function checkPin(inputPin) {
    const storedHash = localStorage.getItem(STORAGE_KEY);
    if (!storedHash) return false;
    const inputHash = await hashPin(inputPin);
    return inputHash === storedHash;
}

function removePin() {
    localStorage.removeItem(STORAGE_KEY);
}
