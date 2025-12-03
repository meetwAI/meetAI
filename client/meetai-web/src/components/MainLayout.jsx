import React from 'react';
import { Link, Outlet } from 'react-router-dom';
import './MainLayout.css';
import { CircleUser, Menu, Home, History } from 'lucide-react';
// Remove unused imports, use only useSidebar
import { useSidebar } from '../globalContext';
// Sidebar state is now passed as props from App.jsx
const MainLayout = ({ username = 'John Doe', userImage = 'https://via.placeholder.com/80' }) => {
    const { sidebarOpen, setSidebarOpen } = useSidebar();
    
    const handleToggle = () => {
        console.log('Button clicked! Current state:', sidebarOpen);
        setSidebarOpen((open) => !open);
    };
    
    return (
        <div className="main-layout">
            <aside className={`sidebar${sidebarOpen ? '' : ' closed'}`}>
                <div className="project-name">meetAI</div>
                <div className="user-section">
                    <img className="user-image small" src={userImage} alt="User" />
                    <div className="username">{username}</div>
                </div>
                                <nav className="nav-links">
                                        <Link to="/" className="nav-link">
                                            <span className="icon" aria-hidden="true"><Home /></span>
                                            <span className="label">Dashboard</span>
                                        </Link>
                                        <Link to="/meetings" className="nav-link">
                                            <span className="icon" aria-hidden="true"><History /></span>
                                            <span className="label">Previous Meetings</span>
                                        </Link>
                                        <Link to="/profile" className="nav-link d-flex align-items-center gap-2">
                                            <span className="icon"><CircleUser /></span>
                                            <span className="label">Profile</span>
                                        </Link>
                                </nav>
                                <button
                                    className="sidebar-toggle-btn mt-auto"
                                    style={{ marginTop: 'auto', marginBottom: 24, background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 22 }}
                                    onClick={handleToggle}
                                    aria-label="Toggle sidebar"
                                >
                                    <Menu />
                                </button>
            </aside>
            <main className="main-content">
                <Outlet />
            </main>
        </div>
    );
};

export default MainLayout;
