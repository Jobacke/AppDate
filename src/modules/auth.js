import { auth } from '../config.js';
import { state } from '../store.js';
import { subscribeCalendar, unsubscribeCalendar } from './calendar.js';
import { showLockScreen, hideLockScreen } from './security.js';

// Helper to centrally manage "Unlocked" state
function finalizeUnlock() {
    const app = document.getElementById('app');

    // 1. Mark session as unlocked
    sessionStorage.setItem('APP_UNLOCKED', 'true');

    // 2. UI Updates
    hideLockScreen();
    if (app) app.classList.remove('hidden');

    // 3. Load Data
    subscribeCalendar();
}
window.finalizeUnlock = finalizeUnlock;


export function initAuth() {
    // Monitor Auth State
    auth.onAuthStateChanged(async user => {
        const app = document.getElementById('app');

        if (user) {
            console.log("Auth State: User is authenticated.", user.uid);
            state.currentUser = user;

            // CHECK SESSION LOCK:
            // Even if we are "Remembered" by Firebase, we require a session unlock (PIN)
            // for every new tab/reload to satisfy the "Pin Lock" requirement.
            const isSessionUnlocked = sessionStorage.getItem('APP_UNLOCKED') === 'true';

            if (isSessionUnlocked) {
                console.log("Session verified. Unlocking.");
                finalizeUnlock();
            } else {
                console.log("New Session / Locked. Showing Lock Screen.");
                // Ensure UI is locked
                showLockScreen(user);
                // Ensure Data is NOT subscribed yet
                unsubscribeCalendar();
            }

        } else {
            console.log("Auth State: User not logged in.");
            state.currentUser = null;
            // Clear session flag just in case
            sessionStorage.removeItem('APP_UNLOCKED');

            unsubscribeCalendar();
            showLockScreen();
            if (app) app.classList.add('hidden');
        }
    });
}
