import React, { act } from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import UploadLanding from './UploadLanding';

const mockNavigate = jest.fn();
global.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('react-router-dom', () => {
  const actual = jest.requireActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

describe('UploadLanding upload path chooser', () => {
  let container;
  let root;

  beforeEach(() => {
    mockNavigate.mockReset();
    localStorage.setItem('userId', 'dev-user');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    document.body.removeChild(container);
    localStorage.clear();
  });

  test('routes video uploads to the dedicated video flow', () => {
    act(() => {
      root.render(
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <UploadLanding />
        </MemoryRouter>,
      );
    });

    const videoButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent.includes('Start Video Upload'),
    );

    expect(videoButton).toBeTruthy();

    act(() => {
      videoButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mockNavigate).toHaveBeenCalledWith('/upload/video');
  });

  test('does not show the dataset process section on the upload chooser', () => {
    act(() => {
      root.render(
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <UploadLanding />
        </MemoryRouter>,
      );
    });

    expect(container.textContent).not.toContain('Submit a dataset');
  });
});
