import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import './App.css';
import Dashboard from './components/Dashboard';
import MainLayout from './components/MainLayout';
import { useSignals } from '@preact/signals-react/runtime';
import PreviousMeetings from './components/PreviousMeetings';
import Login from './components/Login';
import Profile from './components/Profile';

const RequireAuth = ({ children }) => {
  const token = localStorage.getItem('meetai_token');
  if (!token) {
    return <Navigate to="/login" replace />;
  }
  return children;
};

function App() {
  useSignals()
  return (
    <Router>
      <Routes>
        <Route path="/login" element={<Login />} />
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
      </Routes>
    </Router>
  );
}

export default App
