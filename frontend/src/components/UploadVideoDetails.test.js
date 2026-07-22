import React, { act } from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import UploadVideoDetails from './UploadVideoDetails';
import {
  getTrafficVideoArtifact,
  getTrafficVideoJob,
  updateTrafficVideoZones,
} from '../services/api';

const mockNavigate = jest.fn();
global.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('react-router-dom', () => {
  const actual = jest.requireActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

jest.mock('../services/api', () => ({
  getTrafficVideoArtifact: jest.fn(),
  getTrafficVideoJob: jest.fn(),
  restartTrafficVideoProcessing: jest.fn(),
  updateTrafficVideoZones: jest.fn(),
}));

const baseVideo = {
  videoId: '11111111-1111-4111-8111-111111111111',
  fileName: 'traffic.mp4',
  contentType: 'video/mp4',
  durationSeconds: 60,
  width: 1920,
  height: 1080,
  status: 'ready',
  countsStatus: 'not_configured',
  zones: [],
  suggestedZones: [
    {
      id: 'zone-1',
      label: 'Zone 1',
      color: '#00847c',
      points: [
        { x: 5, y: 40 },
        { x: 20, y: 40 },
        { x: 20, y: 60 },
        { x: 5, y: 60 },
      ],
    },
    {
      id: 'zone-2',
      label: 'Zone 2',
      color: '#d97706',
      points: [
        { x: 80, y: 40 },
        { x: 95, y: 40 },
        { x: 95, y: 60 },
        { x: 80, y: 60 },
      ],
    },
  ],
  counts: [],
  trajectories: [
    {
      trackId: '7',
      class: 'car',
      points: [
        { x: 10, y: 50 },
        { x: 90, y: 50 },
      ],
    },
  ],
  artifacts: { preview: true, countsCsv: false },
};

describe('UploadVideoDetails processing results', () => {
  let container;
  let root;

  beforeEach(() => {
    mockNavigate.mockReset();
    getTrafficVideoJob.mockReset();
    getTrafficVideoArtifact.mockReset();
    updateTrafficVideoZones.mockReset();
    sessionStorage.setItem(
      'trafficAtlasVideoUpload',
      JSON.stringify({ videoId: baseVideo.videoId }),
    );
    URL.createObjectURL = jest.fn(() => 'blob:preview');
    URL.revokeObjectURL = jest.fn();
    getTrafficVideoJob.mockResolvedValue({ success: true, video: baseVideo });
    getTrafficVideoArtifact.mockResolvedValue(new Blob(['image'], { type: 'image/jpeg' }));
    updateTrafficVideoZones.mockImplementation((videoId, zones) =>
      Promise.resolve({
        success: true,
        video: {
          ...baseVideo,
          zones,
          countsStatus: 'ready',
          counts: [
            {
              bin_start_s: '0',
              bin_end_s: '900',
              class: 'car',
              from_zone: 'Zone 1',
              to_zone: 'Zone 2',
              count: '3',
            },
          ],
          artifacts: { preview: true, countsCsv: true },
        },
      }),
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    sessionStorage.clear();
  });

  test('renders trajectories and saves suggested zones only after confirmation', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <UploadVideoDetails />
        </MemoryRouter>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(updateTrafficVideoZones).not.toHaveBeenCalled();
    expect(container.querySelectorAll('.trajectory-path')).toHaveLength(1);
    expect(container.querySelectorAll('.trajectory-start')).toHaveLength(1);
    expect(container.querySelectorAll('.trajectory-end')).toHaveLength(1);
    const zoneFill = container.querySelector('.zone-fill');
    const trajectoryPath = container.querySelector('.trajectory-path');
    expect(
      zoneFill.compareDocumentPosition(trajectoryPath) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(container.textContent).toContain('Zone 1');
    expect(container.textContent).toContain('Zone 2');
    expect(container.querySelector('.video-preview-image')).toBeTruthy();

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent.includes('Save zones'),
    );
    await act(async () => {
      saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(updateTrafficVideoZones).toHaveBeenCalledWith(
      baseVideo.videoId,
      expect.arrayContaining([expect.objectContaining({ id: 'zone-1' })]),
    );
    expect(container.textContent).toContain('3 total vehicles');
  });
});
