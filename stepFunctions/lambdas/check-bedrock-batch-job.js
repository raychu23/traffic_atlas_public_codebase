const AWS = require("aws-sdk");
const bedrock = new AWS.Bedrock();

exports.handler = async (event) => {
  console.log("CheckBedrockBatchJob event:", JSON.stringify(event, null, 2));

  const { jobArn } = event;

  try {
    const response = await bedrock.getModelInvocationJob({
      jobIdentifier: jobArn
    }).promise();

    console.log("Job status:", response.status);

    let state = "IN_PROGRESS";

    if (response.status === "Completed") {
      state = "SUCCEEDED";
    } else if (response.status === "Failed") {
      state = "FAILED";
    }

    return {
      success: true,
      jobArn,
      rawStatus: response.status,
      state, // 👈 Step Function will use this
      failureReason: response.failureReason || null
    };

  } catch (error) {
    console.error("CheckBedrockBatchJob error:", error);
    throw error;
  }
};
