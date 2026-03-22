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

const getStoredUser = () => {
  try {
    return JSON.parse(localStorage.getItem('meetai_user') || 'null');
  } catch {
    return null;
  }
};

const RequireAuth = ({ children }) => {
  const user = getStoredUser();
  if (!user) {
    return <LandingPage />;
  }
  return children;
};

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
  const user = getStoredUser();

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
            <RequireAuth>
              <MainLayout />
            </RequireAuth>
          }
        >
          <Route index element={<Dashboard />} />
          <Route path="meetings" element={<PreviousMeetings />} />
          <Route path="meetings/:meetingid" element={<PreviousMeetings />} />
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
