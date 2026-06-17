const AWS = require("aws-sdk");
const bedrock = new AWS.Bedrock();

exports.handler = async (event) => {
  console.log("SubmitBedrockBatchJob event:", JSON.stringify(event, null, 2));

  const {
    dataset_id,
    bucket,
    tagging_input_s3_uri,
    bedrock_output_s3_uri,
    model_id,
    bedrock_role_arn
  } = event;

  try {
    const jobName = `vaidio-tagging-${dataset_id}-${Date.now()}`;

    const params = {
      jobName,
      roleArn: bedrock_role_arn,
      modelId: model_id,

      inputDataConfig: {
        s3InputDataConfig: {
          s3Uri: tagging_input_s3_uri
        }
      },

      outputDataConfig: {
        s3OutputDataConfig: {
          s3Uri: bedrock_output_s3_uri
        }
      }
    };

    const response = await bedrock.createModelInvocationJob(params).promise();

    console.log("Bedrock job submitted:", response);

    return {
      success: true,
      jobArn: response.jobArn,
      jobName,
      dataset_id,
      bedrock_output_prefix: bedrock_output_s3_uri
    };

  } catch (error) {
    console.error("SubmitBedrockBatchJob error:", error);
    throw error;
  }
};
