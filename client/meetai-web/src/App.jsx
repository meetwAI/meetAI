import { useEffect, useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import './App.css';
import Dashboard from './components/Dashboard';
import MainLayout from './components/MainLayout';
import { useSignals } from '@preact/signals-react/runtime';
import PreviousMeetings from './components/PreviousMeetings';
import Login from './components/Login';
import Signup from './components/Signup';
import Profile from './components/Profile';
import ProfileSetup from './components/ProfileSetup';

import LandingPage from './components/LandingPage';
import UpcomingMeetings from './components/UpcomingMeetings';

<<<<<<< HEAD
//checks if localstorage has token
const RequireAuth = ({ children }) => {
  const token = localStorage.getItem('meetai_token');
  if (!token) {
=======
const getStoredUser = () => {
  try {
    return JSON.parse(localStorage.getItem('meetai_user') || 'null');
  } catch {
    return null;
  }
};

const RequireAuth = ({ children, authReady }) => {
  if (!authReady) {
    return null;
  }
  const user = getStoredUser();
  if (!user) {
>>>>>>> main
    return <LandingPage />;
  }
  return children;
};


//Pages you should only see if you are not logged in
const AuthRoute = ({ children }) => {
  const user = getStoredUser();
  if (user) {
    return <Navigate to="/" replace />;
  }
  return children;
};

// Profile setup is only reachable with a signed-in user.
const ProfileSetupRoute = ({ children }) => {
  const user = getStoredUser();
  if (!user) {
    return <Navigate to="/signup" replace />;
  }
  return children;
};

function App() {
  useSignals()
  const [authReady, setAuthReady] = useState(false);
  const [, setAuthTick] = useState(0);
  const user = getStoredUser();
  const API_URL = import.meta.env.VITE_AUTH_URL || import.meta.env.VITE_API_URL;

  useEffect(() => {
    let isMounted = true;

    const bootstrapAuth = async () => {
      if (getStoredUser()) {
        if (isMounted) setAuthReady(true);
        return;
      }

      try {
        const response = await fetch(`${API_URL}/verify`, {
          method: 'POST',
          credentials: 'include',
        });
        if (!response.ok) {
          return;
        }
        const payload = await response.json();
        if (payload?.user) {
          localStorage.setItem('meetai_user', JSON.stringify(payload.user));
          if (isMounted) {
            setAuthTick((tick) => tick + 1);
          }
        }
      } catch (_error) {
        // Ignore bootstrap failures; user can still log in manually.
      } finally {
        if (isMounted) setAuthReady(true);
      }
    };

    bootstrapAuth();
    return () => {
      isMounted = false;
    };
  }, [API_URL]);

  return (
    <Router>
      <Routes>
        <Route path="/login" element={
          <AuthRoute>
            <Login />
          </AuthRoute>
        } />

        <Route path="/signup" element={
          <AuthRoute>
            <Signup />
          </AuthRoute>
        } />

        <Route path="/profile-setup" element={
          <ProfileSetupRoute>
            <ProfileSetup />
          </ProfileSetupRoute>
        } />

        <Route
          path="/"
          element={
            <RequireAuth authReady={authReady}>
              <MainLayout />
            </RequireAuth>
          }
        >
          <Route index element={<Dashboard />} />
          <Route path="meetings" element={<PreviousMeetings />} />
          <Route path="meetings/:meetingid" element={<PreviousMeetings />} />
          <Route path="upcoming-meetings" element={<UpcomingMeetings />} />
          <Route path="profile" element={<Profile />} />
        </Route>

        <Route
          path="*"
          element={user ? <Navigate to="/" replace /> : <LandingPage />}
        />
      </Routes>
    </Router>
  );
}

export default App
