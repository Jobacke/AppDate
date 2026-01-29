import { db, auth, firebase, SHARED_USER_EMAIL, PIN_SALT } from '../config.js';
import { state } from '../store.js';
// Removed circular import: import { finalizeUnlock } from './auth.js';


// State
let currentPinInput = [];
let modalMode = 'none'; // 'setup', 'change-verify-old', 'change-new'
let unlockCallback = null; // Callback to trigger unlock in auth.js

// Exports for HTML
export function initSecurity(onUnlockSuccess) {
    if (onUnlockSuccess) unlockCallback = onUnlockSuccess;

    window.openSecuritySettings = openSecuritySettings;
    window.closeSecurityModal = closeSecurityModal;
    window.startPinChange = startPinChange;
    // window.startPinRemoval = startPinRemoval; // Removed for security
    window.lockApp = lockApp;
    window.confirmPinAction = confirmPinAction;
    window.cancelPinAction = cancelPinAction;
    window.clearPinDigit = clearPinDigit;
    window.triggerBiometricUnlock = triggerBiometricUnlock;
    window.setupBiometricFromSettings = setupBiometricFromSettings; // New Manual Setup

    // Bind Security Button
    const btnSecurity = document.getElementById('btnSecurity');
    if (btnSecurity) {
        btnSecurity.addEventListener('click', openSecuritySettings);
    }

    // Bind Keypad clicks
    document.querySelectorAll('.pin-key').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const digit = e.target.getAttribute('data-num');
            if (digit) handlePinDigit(digit);
        });
    });
}

// --- Auth / Lock Logic ---

// Biometry Text
const BIO_KEY = "appdate_bio_cred_id";

export function showLockScreen() {
    const lockScreen = document.getElementById('lockScreen');
    if (lockScreen) {
        lockScreen.classList.remove('hidden');
        lockScreen.classList.add('flex');
    }
    currentPinInput = [];
    updatePinDisplay();

    // Check if Bio is available
    checkBiometricAvailability();
}

export function hideLockScreen() {
    const lockScreen = document.getElementById('lockScreen');
    if (lockScreen) {
        lockScreen.classList.add('hidden');
        lockScreen.classList.remove('flex');
    }
    currentPinInput = [];
}

export function lockApp() {
    // Explicitly clear session flag
    sessionStorage.removeItem('APP_UNLOCKED');

    // Soft Lock: We do NOT signOut. We just reload.
    // This allows FaceID to work (because Firebase session is still active in background).
    // Security: initAuth will see User + No Flag -> Lock Screen forces PIN or FaceID.
    window.location.reload();
}

async function handlePinDigit(digit) {
    // Only process input if lock screen is visible OR inside modal pin view
    const lockScreen = document.getElementById('lockScreen');
    const modalPinView = document.getElementById('securityPinView');

    // Determine context. 
    // If modal is open and in pin view, don't use the lock screen keypad logic?
    // Wait, the lock screen has its OWN keypad in HTML?
    // Assuming the event listeners attached to '.pin-key' cover BOTH keypads if they share class, 
    // OR they are unique.
    // In many apps, the lock screen is an overlay.
    // If the modal is open, we usually use the input field `modalPinInput` and correct button clicks?
    // The previous implementation used `modalPinInput` for the modal, and keypad for the lock screen.
    // Let's stick to that separation.

    // If Lock Screen is hidden, ignore this keypad (unless it's the modal keypad?)
    // Typically `pin-key` class is used on the Lock Screen keypad.
    if (lockScreen.classList.contains('hidden')) return;

    if (currentPinInput.length < 4) {
        currentPinInput.push(digit);
        updatePinDisplay();

        if (currentPinInput.length === 4) {
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
    const container = document.getElementById('pinDisplayDots');
    if (!container) return;
    const dots = container.children;
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
    const pin = currentPinInput.join('');
    // Dynamic Email based on PIN allows multiple users
    const dynamicEmail = `user-${pin}@appdate.local`;
    const password = pin + PIN_SALT;

    // UI Feedback
    const msgEl = document.getElementById('lockMessage');
    msgEl.textContent = 'Prüfe...';

    try {
        // Log in with the Specific User for this PIN
        await auth.signInWithEmailAndPassword(dynamicEmail, password);

        msgEl.textContent = 'Erfolg';
        if (unlockCallback) unlockCallback();

        // Ask for Biometric Setup if tech supported and not yet done
        // setTimeout(async () => {
        //     await possiblySetupBiometric();
        // }, 500);

    } catch (error) {
        console.error("Login Error:", error);

        // 'auth/user-not-found' => User doesn't exist yet (Normal for first setup)
        // 'auth/invalid-credential' => Often happens if cache is stale or user was deleted but browser thinks it exists. Treat as "Not Found".
        if (error.code === 'auth/user-not-found' || error.code === 'auth/invalid-credential') {

            // Explicitly sign out first to clear any zombie state
            await auth.signOut();

            if (confirm(`PIN ${pin} ist noch nicht eingerichtet. Möchtest du ihn jetzt aktivieren?`)) {
                try {
                    await auth.createUserWithEmailAndPassword(dynamicEmail, password);
                    if (unlockCallback) unlockCallback();
                } catch (e) {
                    showLockError("Fehler: " + e.message);
                    shake();
                }
            } else {
                showLockError("PIN nicht gefunden.");
                shake();
            }
        } else if (error.code === 'auth/wrong-password') {
            // Should rarely happen unless collision or logic change
            showLockError("Falscher Code.");
            shake();
        } else if (error.code === 'auth/too-many-requests') {
            showLockError("Zu viele Versuche. Warte kurz.");
            shake();
        } else {
            showLockError("Fehler: " + error.message);
            shake();
        }
    }
}

function showLockError(msg) {
    const el = document.getElementById('lockMessage');
    if (el) el.textContent = msg;
}

function shake() {
    const dotsContainer = document.getElementById('pinDisplayDots');
    if (dotsContainer) {
        dotsContainer.classList.add('animate-shake'); // Tailwind custom animation or class
        setTimeout(() => {
            currentPinInput = [];
            updatePinDisplay();
            dotsContainer.classList.remove('animate-shake');
        }, 500);
    }
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
    const err = document.getElementById('modalPinError');
    if (err) err.textContent = '';

    modalMode = 'none';

    document.getElementById('pinManageSection').classList.remove('hidden');
    document.getElementById('pinSetupSection').classList.add('hidden');

    // Update Manual Bio Button Visibility
    const btnBio = document.getElementById('btnSetupBioManual');
    if (btnBio) {
        if (window.PublicKeyCredential) {
            btnBio.classList.remove('hidden');
            // Change Text if already active?
            if (localStorage.getItem(BIO_KEY)) {
                btnBio.innerHTML = '<i class="ph-check-circle-bold text-xl"></i> Face ID aktiv (Neu koppeln)';
            } else {
                btnBio.innerHTML = '<i class="ph-fingerprint-simple-bold text-xl"></i> Face ID / Touch ID koppeln';
            }
        } else {
            btnBio.classList.add('hidden');
        }
    }
}

function showPinView(title, desc, mode) {
    document.getElementById('securityMainView').classList.add('hidden');
    document.getElementById('securityPinView').classList.remove('hidden');
    document.getElementById('securityPinView').classList.add('flex');

    document.getElementById('pinViewTitle').textContent = title;
    document.getElementById('pinViewDesc').textContent = desc;

    const input = document.getElementById('modalPinInput');
    input.value = '';
    input.focus();

    modalMode = mode;
}

function startPinChange() {
    showPinView('Authentifizierung', 'Alten PIN eingeben', 'change-verify-old');
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

    if (modalMode === 'change-verify-old') {
        const isValid = await reauthUser(input);
        if (isValid) {
            showPinView('Neuer PIN', 'Bitte neuen Code eingeben', 'change-new');
        } else {
            errorEl.textContent = 'Falscher PIN.';
        }
    } else if (modalMode === 'change-new') {
        await updatePin(input);
        closeSecurityModal();
        alert('PIN erfolgreich geändert!');
    }
}

// --- Auth Helpers ---

async function reauthUser(pin) {
    try {
        const password = pin + PIN_SALT;
        const cred = firebase.auth.EmailAuthProvider.credential(SHARED_USER_EMAIL, password);
        await auth.currentUser.reauthenticateWithCredential(cred);
        return true;
    } catch (e) {
        console.error("Reauth failed", e);
        return false;
    }
}

async function updatePin(pin) {
    try {
        const password = pin + PIN_SALT;
        await auth.currentUser.updatePassword(password);
    } catch (e) {
        console.error("Update password failed", e);
        alert("Fehler beim Ändern: " + e.message);
    }
}

// === Biometric Logic (FaceID / TouchID) ===

async function checkBiometricAvailability() {
    // 1. Browser Support?
    if (!window.PublicKeyCredential) return;

    // 2. Already set up?
    const hasCred = localStorage.getItem(BIO_KEY);
    const btn = document.getElementById('btnBiometricUnlock');

    // Only show button if we have a credential registered AND we are conceptually logged in (User exists)
    // If we are signed out (User is null), FaceID makes no sense as we can't get session.
    // But showLockScreen is also called when User is null.

    if (hasCred && auth.currentUser) {
        if (btn) {
            btn.classList.remove('hidden');
            btn.classList.add('flex');
        }
        // Auto-Trigger? Maybe annoying. Let user click.
    } else {
        if (btn) {
            btn.classList.add('hidden');
            btn.classList.remove('flex');
        }
    }
}

async function possiblySetupBiometric() {
    if (!window.PublicKeyCredential) return;

    // If already set up, skip
    if (localStorage.getItem(BIO_KEY)) return;

    // Ask user
    // Only ask if Platform Authenticator is available (FaceID/TouchID)
    try {
        const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
        if (!available) return;
    } catch (e) { return; }

    if (!confirm("Möchtest du Face ID / Touch ID für schnelleres Entsperren aktivieren?")) return;

    registerBiometric();
}

async function registerBiometric() {
    try {
        const randomChallenge = new Uint8Array(32);
        window.crypto.getRandomValues(randomChallenge);

        const publicKey = {
            challenge: randomChallenge,
            rp: { name: "AppDate Secured", id: window.location.hostname },
            user: {
                id: Uint8Array.from(auth.currentUser.uid, c => c.charCodeAt(0)),
                name: auth.currentUser.email || "User",
                displayName: "AppDate User"
            },
            pubKeyCredParams: [{ alg: -7, type: "public-key" }],
            authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" },
            timeout: 60000
        };

        const credential = await navigator.credentials.create({ publicKey });

        // Save ID to know we have it. 
        // Note: In a real backend scenario, we would send this to server.
        // Here we just use it as a "local toggle" confirmation.
        localStorage.setItem(BIO_KEY, "active");

        alert("Face ID / Touch ID erfolgreich eingerichtet!");

    } catch (e) {
        console.error("Bio Setup Error:", e);
        alert("Einrichtung fehlgeschlagen: " + e.message);
    }
}

window.triggerBiometricUnlock = async function () {
    try {
        const randomChallenge = new Uint8Array(32);
        window.crypto.getRandomValues(randomChallenge);

        const publicKey = {
            challenge: randomChallenge,
            rpId: window.location.hostname,
            userVerification: "required",
            timeout: 60000
        };

        // This triggers the System FaceID/TouchID prompt
        await navigator.credentials.get({ publicKey });

        // If we survive this call, it means the user passed verification.
        // Since we are checking against "Platform Authenticator", the device confirmed "User is Owner".
        // Trusts: Device OS.

        // Success -> Unlock
        if (unlockCallback) unlockCallback();

    } catch (e) {
        console.error("Bio Unlock Error:", e);
        // Silent fail or shake
        shake();
    }
};

async function setupBiometricFromSettings() {
    if (!confirm("Möchtest du dieses Gerät mit deinem Account verknüpfen (via FaceID/TouchID)?")) return;
    await registerBiometric();
    // Refresh UIO
    resetModalView();
}
