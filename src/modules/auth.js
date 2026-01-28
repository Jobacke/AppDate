import { auth } from '../config.js';
import { state } from '../store.js';
import { subscribeCalendar, unsubscribeCalendar } from './calendar.js';
import { checkLockRequirement } from './security.js';

export function initAuth() {
    // Monitor Auth State
    auth.onAuthStateChanged(async user => {
        if (user) {
            console.log("User authenticated:", user.uid);
            state.currentUser = user;

            // Critical: Check if this user needs a PIN lock
            // This function checks Firestore and shows the lock screen if a PIN hash exists.
            await checkLockRequirement();

            // Make the main app container visible.
            // If locked, the #lockScreen overlay (z-index 100) will cover it.
            const app = document.getElementById('app');
            if (app) app.classList.remove('hidden');

            subscribeCalendar();
        } else {
            console.log("User not logged in.");
            state.currentUser = null;
            unsubscribeCalendar();

            // If not logged in, we rely on anonymous login or explicit login flow.
            // But usually anonymous login kicks in automatically if enabled.
        }
    });
}

