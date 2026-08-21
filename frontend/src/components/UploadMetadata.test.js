import React, { act } from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import UploadMetadata from './UploadMetadata';

const mockNavigate = jest.fn();
global.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('react-router-dom', () => {
  const actual = jest.requireActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

jest.mock('../services/api', () => ({
  __esModule: true,
  API_PUBLIC_BASE_URL: 'http://localhost:5001/api',
  default: {
    post: jest.fn(),
  },
  getUploadTerms: jest.fn(() => Promise.resolve({ success: true, documents: [] })),
  initiateSampleMultipartUpload: jest.fn(),
  getSampleMultipartParts: jest.fn(),
  getSampleMultipartPartUrl: jest.fn(),
  completeSampleMultipartUpload: jest.fn(),
}));

describe('UploadMetadata sample upload gate', () => {
  let container;
  let root;

  beforeEach(() => {
    mockNavigate.mockReset();
    window.scrollTo = jest.fn();
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

  test('shows sample upload gate before the metadata stepper', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <UploadMetadata />
        </MemoryRouter>,
      );
    });

    expect(container.textContent).toContain('Submit a dataset');
    expect(container.textContent).toContain('Upload Sample Dataset');
    expect(container.textContent).toContain('Choose a sample');
    expect(container.textContent).toContain('Submit for review');
    expect(container.textContent).not.toContain('Describe the dataset');
    expect(container.textContent).not.toContain('Core Metadata*');
  });

  test('shows metadata form after a sample ZIP is selected', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <UploadMetadata />
        </MemoryRouter>,
      );
    });

    const fileInput = container.querySelector('#datasetSampleZipFile');
    const zipFile = new File(['sample'], 'sample-dataset.zip', { type: 'application/zip' });

    await act(async () => {
      Object.defineProperty(fileInput, 'files', {
        value: [zipFile],
        configurable: true,
      });
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const uploadButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent.includes('Continue'),
    );

    await act(async () => {
      uploadButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('Core Metadata*');
    expect(container.textContent).toContain('File Details');
  });
});
