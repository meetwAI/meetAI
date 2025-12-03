import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import './App.css';
import Dashboard from './components/Dashboard';
import MainLayout from './components/MainLayout';
import { SidebarProvider } from './globalContext';

// Placeholder components for new routes
const PreviousMeetings = () => <div>Previous Meetings</div>;
const Profile = () => <div>Profile</div>;

function App() {
  return (
    <SidebarProvider>
      <Router>
        <Routes>
          <Route path="/" element={<MainLayout />}> 
            <Route index element={<Dashboard />} />
            <Route path="meetings" element={<PreviousMeetings />} />
            <Route path="profile" element={<Profile />} />
          </Route>
        </Routes>
      </Router>
    </SidebarProvider>
  );
}

export default App
