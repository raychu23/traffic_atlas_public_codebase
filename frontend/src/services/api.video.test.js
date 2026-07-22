import { validateTrafficVideoUpload } from './api';

var mockApiClient;

jest.mock('axios', () => {
  mockApiClient = {
    delete: jest.fn(),
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    interceptors: {
      request: { use: jest.fn() },
      response: { use: jest.fn() },
    },
  };
  return { create: jest.fn(() => mockApiClient) };
});

describe('traffic-video upload API contract', () => {
  test('sends the selected file in the multipart videoFile field', async () => {
    const progressHandler = jest.fn();
    const videoFile = new File(['video'], 'intersection.mp4', { type: 'video/mp4' });
    mockApiClient.post.mockResolvedValue({ data: { success: true } });

    await validateTrafficVideoUpload(videoFile, progressHandler);

    expect(mockApiClient.post).toHaveBeenCalledWith(
      '/videos/validate-upload',
      expect.any(FormData),
      {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: progressHandler,
      },
    );
    const requestBody = mockApiClient.post.mock.calls[0][1];
    expect(requestBody.get('videoFile')).toBe(videoFile);
  });
});
