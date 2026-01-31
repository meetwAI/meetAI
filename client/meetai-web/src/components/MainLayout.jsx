import React from 'react';
import { Link, Outlet } from 'react-router-dom';
import './MainLayout.css';
import { CircleUser, Home, History } from 'lucide-react';

const MainLayout = ({ username = 'John Doe', userImage = 'https://via.placeholder.com/80' }) => {
    return (
        <div className="">
            <div className="topbar" role="banner">
                <div>
                    <div className="">meetAI</div>
                </div>
                <div className="d-flex align-items-center justify-content-end" role="navigation" aria-label="user">
                    <Link to="/" className="nav-link" aria-label="Dashboard">
                        <span className="icon" aria-hidden="true"><Home /></span>
                    </Link>
                    <Link to="/meetings" className="nav-link" aria-label="Previous meetings">
                        <span className="icon" aria-hidden="true"><History /></span>
                    </Link>
                    <Link to="/profile" className="nav-link" aria-label="Profile">
                        <span className="icon"><CircleUser /></span>
                    </Link>
                </div>
            </div>

            <main className="main-content">
                <Outlet />
            </main>
        </div>
    );
};

export default MainLayout;
