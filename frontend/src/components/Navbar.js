import React, { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { getAuthState, notifyAuthChanged, clearAuthTokens } from '../services/authState';
import { getNotificationSummary, getAuthMe } from '../services/api';
import './Navbar.css';

function Navbar() {
  const navigate = useNavigate();
  const [authState, setAuthState] = useState(getAuthState());
  const token = authState.token;
  const isAdmin = authState.isAdmin;
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [notificationCounts, setNotificationCounts] = useState(() => {
    const msgRaw = localStorage.getItem('notificationMessagesCount');
    const reqRaw = localStorage.getItem('notificationRequestsCount');
    return {
      messages: msgRaw ? Number(msgRaw) || 0 : 0,
      requests: reqRaw ? Number(reqRaw) || 0 : 0
    };
  });
  const totalNotifications = notificationCounts.messages + notificationCounts.requests;
  const hasNotifications = isAdmin || totalNotifications > 0;

  useEffect(() => {
    const sync = () => setAuthState(getAuthState());
    const syncNotifications = () => {
      const msgRaw = localStorage.getItem('notificationMessagesCount');
      const reqRaw = localStorage.getItem('notificationRequestsCount');
      setNotificationCounts({
        messages: msgRaw ? Number(msgRaw) || 0 : 0,
        requests: reqRaw ? Number(reqRaw) || 0 : 0
      });
    };
    window.addEventListener('storage', sync);
    window.addEventListener('auth-changed', sync);
    window.addEventListener('notification-changed', syncNotifications);
    
    // Close dropdown when clicking outside
    const handleClickOutside = (event) => {
      if (showProfileMenu && !event.target.closest('.profile-dropdown')) {
        setShowProfileMenu(false);
      }
    };
    
    document.addEventListener('click', handleClickOutside);
    
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener('auth-changed', sync);
      window.removeEventListener('notification-changed', syncNotifications);
      document.removeEventListener('click', handleClickOutside);
    };
  }, [showProfileMenu]);

  useEffect(() => {
    let mounted = true;
    const refreshAuth = async () => {
      if (!token) return;
      try {
        const res = await getAuthMe();
        if (!mounted || !res?.success || !res.user) return;
        localStorage.setItem('userId', res.user.userId || '');
        localStorage.setItem('userName', res.user.name || '');
        localStorage.setItem('userEmail', res.user.email || '');
        localStorage.setItem('userOrganization', res.user.organization || '');
        localStorage.setItem('userRole', res.user.role || '');
        if (typeof res.user.isAdmin === 'boolean') {
          localStorage.setItem('userIsAdmin', String(res.user.isAdmin));
        }
        notifyAuthChanged();
      } catch {
        // ignore refresh failures
      }
    };

    refreshAuth();
    const intervalId = window.setInterval(refreshAuth, 60000);
    const onFocus = () => refreshAuth();
    window.addEventListener('focus', onFocus);
    return () => {
      mounted = false;
      window.clearInterval(intervalId);
      window.removeEventListener('focus', onFocus);
    };
  }, [token]);

  useEffect(() => {
    if (!authState.isLoggedIn) return;
    let isMounted = true;

    const refreshNotifications = async () => {
      try {
        const res = await getNotificationSummary();
        if (!isMounted || !res.success) return;
        localStorage.setItem('notificationMessagesCount', String(res.messages || 0));
        localStorage.setItem('notificationRequestsCount', String(res.requests || 0));
        window.dispatchEvent(new Event('notification-changed'));
      } catch (e) {
        // ignore background poll errors
      }
    };

    refreshNotifications();
    const intervalId = window.setInterval(refreshNotifications, 30000);
    const visibilityHandler = () => {
      if (document.visibilityState === 'visible') refreshNotifications();
    };
    document.addEventListener('visibilitychange', visibilityHandler);

    return () => {
      isMounted = false;
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', visibilityHandler);
    };
  }, [authState.isLoggedIn]);

  const handleLogout = () => {
    clearAuthTokens();
    notifyAuthChanged();
    setShowProfileMenu(false);
    window.location.href = '/login';
  };

  const getUserInitials = () => {
    const email = localStorage.getItem('userEmail') || '';
    const name = localStorage.getItem('userName') || '';
    const displayName = name || email;
    return displayName.charAt(0).toUpperCase();
  };

  const getUserEmail = () => {
    return localStorage.getItem('userEmail') || '';
  };

  const getUserName = () => {
    return localStorage.getItem('userName') || 'User';
  };

  const getUserOrganization = () => {
    return localStorage.getItem('userOrganization') || 'Not specified';
  };

  const getUserRole = () => {
    const role = localStorage.getItem('userRole');
    if (role) return role;
    return isAdmin ? 'Administrator' : 'User';
  };

  const getMemberSince = () => {
    const signUpDate = localStorage.getItem('userSignUpDate');
    if (signUpDate) {
      return new Date(signUpDate).toLocaleDateString();
    }
    return new Date().toLocaleDateString();
  };

  return (
    <nav className="navbar">
      <div className="navbar-brand">
        <span className="brand-name" onClick={() => navigate('/discover')} style={{ cursor: 'pointer' }}>Traffic Atlas</span>
      </div>
      <div className="navbar-main-nav">
        <NavLink to="/discover" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>Datasets</NavLink>
        <NavLink to="/upload" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>Upload</NavLink>
      </div>
      <div className="navbar-links">
        {!token && <NavLink to="/register" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>Register</NavLink>}
        {!token && <NavLink to="/login" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>Login</NavLink>}
        {isAdmin && <NavLink to="/admin" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>Admin</NavLink>}
        {token && (
          <div className="profile-dropdown">
            <button 
              className="profile-button" 
              onClick={(e) => {
                e.stopPropagation();
                setShowProfileMenu(!showProfileMenu);
              }}
            >
              <div className="profile-avatar-wrap">
                <div className="profile-notification">
                  <div className="profile-avatar">
                    {getUserInitials()}
                  </div>
                  <div className="profile-notification-bell">
                    <span className="notification-icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M15 17h5l-1.4-1.4A2 2 0 0 1 18 14.2V11a6 6 0 1 0-12 0v3.2a2 2 0 0 1-.6 1.4L4 17h5" />
                        <path d="M9 17a3 3 0 0 0 6 0" />
                      </svg>
                    </span>
                    {totalNotifications > 0 && (
                      <span className="notification-badge" aria-label={`${totalNotifications} notifications`}>
                        {totalNotifications > 99 ? '99+' : totalNotifications}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </button>
            {showProfileMenu && (
              <div className="profile-menu">
                <div
                  className="profile-header"
                  onClick={() => {
                    setShowProfileMenu(false);
                    navigate('/profile');
                  }}
                  style={{ cursor: 'pointer' }}
                >
                  <div className="profile-avatar-large">
                    {getUserInitials()}
                  </div>
                  <div className="profile-info">
                    <div className="profile-name">{getUserName()}</div>
                    <div className="profile-email">{getUserEmail()}</div>
                  </div>
                </div>
                {hasNotifications && (
                  <div
                    className="profile-notification-panel"
                    onClick={() => {
                      setShowProfileMenu(false);
                      navigate('/admin');
                    }}
                    style={{ cursor: 'pointer' }}
                  >
                    <div className="profile-notification-panel-header">
                      <span className="profile-notification-panel-title">Notifications</span>
                      <span className="profile-notification-panel-total">
                        {totalNotifications > 0 ? `${totalNotifications} total` : 'Admin inbox'}
                      </span>
                    </div>
                    <div className="profile-notification-summary">
                      <div className="profile-notification-card">
                        <span className="profile-notification-label">Messages</span>
                        <span className="profile-notification-value">{notificationCounts.messages}</span>
                      </div>
                      <div className="profile-notification-card alt">
                        <span className="profile-notification-label">Requests</span>
                        <span className="profile-notification-value">{notificationCounts.requests}</span>
                      </div>
                    </div>
                  </div>
                )}
                <div className="profile-details">
                  <div className="profile-detail">
                    <span className="detail-label">Organization:</span>
                    <span className="detail-value">{getUserOrganization()}</span>
                  </div>
                  <div className="profile-detail">
                    <span className="detail-label">Role:</span>
                    <span className="detail-value">{getUserRole()}</span>
                  </div>
                  <div className="profile-detail">
                    <span className="detail-label">Member Since:</span>
                    <span className="detail-value">{getMemberSince()}</span>
                  </div>
                </div>
                <div className="profile-actions">
                  <NavLink 
                    to="/profile" 
                    className="profile-action-link"
                    onClick={() => setShowProfileMenu(false)}
                  >
                    View Profile
                  </NavLink>
                  <button className="profile-logout" onClick={handleLogout}>
                    Logout
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </nav>
  );
}

export default Navbar;
