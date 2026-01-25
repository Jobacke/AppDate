import firebase from 'firebase/compat/app';
import 'firebase/compat/auth';
import 'firebase/compat/firestore';

const firebaseConfig = {
    apiKey: "AIzaSyBWcbJIz5oKCVCtHfDYxAOKb4io1mgg4JQ",
    authDomain: "appdate-backend.firebaseapp.com",
    projectId: "appdate-backend",
    storageBucket: "appdate-backend.firebasestorage.app",
    messagingSenderId: "335885703338",
    appId: "1:335885703338:web:3b94d4fe98322ed337d8d3"
};

if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}

export const auth = firebase.auth();
export const db = firebase.firestore();
export { firebase };
