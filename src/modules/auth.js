import { auth } from '../config.js';
import { state } from '../store.js';
import { subscribeCalendar, unsubscribeCalendar } from './calendar.js';

export function initAuth() {
    // Auto-login anonymously to ensure Firestore access without user interaction
    auth.signInAnonymously().catch(error => {
        console.error("Anonymous login failed", error);
    });

    auth.onAuthStateChanged(user => {
        if (user) {
            state.currentUser = user;
            // Always show app, hide login screen (which we will remove from HTML)
            const app = document.getElementById('app');
            if (app) app.classList.remove('hidden');

            subscribeCalendar();
        } else {
            // Should not happen with anonymous login, but handle graceful retry or error
        }
    });
}

