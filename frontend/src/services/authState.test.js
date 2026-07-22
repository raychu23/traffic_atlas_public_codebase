import { getAuthState } from './authState';

describe('getAuthState dev auth', () => {
  const originalDevAuth = process.env.REACT_APP_DEV_AUTH_ENABLED;

  afterEach(() => {
    localStorage.clear();
    process.env.REACT_APP_DEV_AUTH_ENABLED = originalDevAuth;
  });

  test('returns a valid local dev token when dev auth is enabled', () => {
    process.env.REACT_APP_DEV_AUTH_ENABLED = 'true';

    const auth = getAuthState();

    expect(auth.token).toBe('dev-local-token');
    expect(auth.isLoggedIn).toBe(true);
    expect(localStorage.getItem('authToken')).toBe('dev-local-token');
    expect(localStorage.getItem('userEmail')).toBe('dev@traffic-atlas.local');
  });
});
