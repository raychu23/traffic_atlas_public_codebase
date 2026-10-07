function getVideoUploadErrorResponse(error) {
  if (error?.code === "NOT_TRAFFIC_CAMERA_FOOTAGE") {
    return {
      status: 422,
      message: error.message || "This video does not appear to contain traffic-camera footage.",
      trafficScene: error.scene || null,
    };
  }

  if (
    error?.code === "OPENAI_TRAFFIC_SCENE_UNAVAILABLE" ||
    /OPENAI_API_KEY|OpenAI traffic-scene/i.test(error?.message || "")
  ) {
    return {
      status: 503,
      message: "Traffic-scene validation is temporarily unavailable. Try again later.",
      trafficScene: null,
    };
  }

  if (/duration/i.test(error?.message || "")) {
    return { status: 400, message: error.message, trafficScene: null };
  }

  if (
    /format|ffprobe|ffmpeg|video dimensions|extract preview|determine video/i.test(
      error?.message || "",
    )
  ) {
    return {
      status: 400,
      message: "Unable to read this video. Upload a valid file in one of the supported formats.",
      trafficScene: null,
    };
  }

  return {
    status: 500,
    message: "Unable to process the video upload.",
    trafficScene: null,
  };
}

module.exports = { getVideoUploadErrorResponse };
