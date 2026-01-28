import { auth } from '../config.js';
import { state } from '../store.js';
import { subscribeCalendar } from './calendar.js';
import { checkLockRequirement } from './security.js';

export function initAuth() {
    // Auto-login anonymously to ensure Firestore access without user interaction
    auth.signInAnonymously().catch(error => {
        console.error("Anonymous login failed", error);
    });

    auth.onAuthStateChanged(async user => {
        if (user) {
            state.currentUser = user;

            // Sync check for PIN requirement
            await checkLockRequirement();

            // Afterward, we can ensure the app is visible (unless locked by checkLockRequirement logic which shows overlay)
            const app = document.getElementById('app');
            if (app) app.classList.remove('hidden');

            subscribeCalendar();
        } else {
            // Should not happen with anonymous login
        }
    });
}

