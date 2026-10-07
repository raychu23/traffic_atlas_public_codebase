import { buildUploadErrorMessage } from './UploadVideo';

jest.mock('../services/api', () => ({
  API_PUBLIC_BASE_URL: 'https://traffic-api.example.test',
  validateTrafficVideoUpload: jest.fn(),
}));

describe('buildUploadErrorMessage', () => {
  test('reports an unreachable API separately from traffic-scene rejection', () => {
    const message = buildUploadErrorMessage(new Error('Network Error'));

    expect(message).toContain('Cannot reach the TrafficAtlas API');
    expect(message).toContain('https://traffic-api.example.test');
    expect(message).not.toContain('clear roadway');
  });

  test('adds the roadway guidance only to an actual scene rejection', () => {
    const message = buildUploadErrorMessage({
      response: {
        status: 422,
        data: { error: 'The sampled frames do not show traffic-camera footage.' },
      },
    });

    expect(message).toContain('clear roadway');
  });

  test('shows backend service errors without claiming the video was rejected', () => {
    const message = buildUploadErrorMessage({
      response: {
        status: 503,
        data: { error: 'Traffic-scene validation is temporarily unavailable.' },
      },
    });

    expect(message).toBe('Traffic-scene validation is temporarily unavailable.');
  });
});
