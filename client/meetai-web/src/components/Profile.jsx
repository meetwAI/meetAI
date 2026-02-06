import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { disconnectSocket } from '../api/socketClient';

export default function Profile() {
  const navigate = useNavigate();

  const user = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem('meetai_user') || 'null');
    } catch {
      return null;
    }
  }, []);

  const handleLogout = () => {
    try {
      disconnectSocket();
    } catch (e) {
      // ignore
    }
    localStorage.removeItem('meetai_token');
    localStorage.removeItem('meetai_user');
    navigate('/login', { replace: true });
  };

  return (
    <div className="profile-page">
      <h1>Profile</h1>
      <p>Signed in as: {user?.username || 'Unknown'}</p>
      <button type="button" className="primary-button" onClick={handleLogout}>
        Log out
      </button>
    </div>
  );
}
