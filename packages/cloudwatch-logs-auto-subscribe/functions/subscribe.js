const lambda = require("./lib/lambda");
const cloudWatchLogs = require("./lib/cloudwatch-logs");
const log = require("@dazn/lambda-powertools-logger");

const { DESTINATION_ARN } = process.env;

module.exports.existingLogGroups = async () => {
	const logGroupNames = await cloudWatchLogs.getLogGroups();
	for (const logGroupName of logGroupNames) {
		try {
			if (await filter(logGroupName)) {
				const destinationArn = await cloudWatchLogs.getSubscriptionFilter(logGroupName);
				if (!destinationArn) {
					log.debug(`[${logGroupName}] doesn't have a filter yet`);
          
					// swallow exception so we can move onto the next log group
					await subscribe(logGroupName).catch(() => {});
				} else if (destinationArn !== DESTINATION_ARN) {
					log.debug(`[${logGroupName}] has an old destination ARN [${destinationArn}], updating...`, {
						logGroupName,
						oldArn: destinationArn,
						arn: DESTINATION_ARN
					});
          
					// swallow exception so we can move onto the next log group
					await subscribe(logGroupName).catch(console.error);
				}
			}
		} catch(error) {
			log.warn("cannot process existing log group, skipped...", { logGroupName }, error);
		}
	}
};

module.exports.newLogGroups = async (event) => {
	log.debug("received event...", { event });

	// eg. /aws/lambda/logging-demo-dev-api
	const logGroupName = event.detail.requestParameters.logGroupName;
	if (await filter(logGroupName)) {
		await subscribe(logGroupName);
	}
};

const filter = async (logGroupName) => {
	log.debug("checking log group...", { logGroupName });
  
	const { PREFIX, EXCLUDE_PREFIX } = process.env;

	if (EXCLUDE_PREFIX && logGroupName.startsWith(EXCLUDE_PREFIX)) {
		log.debug(`ignored [${logGroupName}] because it matches the exclude prefix`, {
			logGroupName,
			excludePrefix: EXCLUDE_PREFIX
		});
		return false;
	}

	if (PREFIX && !logGroupName.startsWith(PREFIX)) {
		log.debug(`ignored [${logGroupName}] because it doesn't match the prefix`, {
			logGroupName,
			prefix: PREFIX
		});
		return false;
	}
  
	const hasRequiredTags = (process.env.TAGS || "")
		.split(",")
		.filter(x => x.length > 0)
		.map(tag => {
			const segments = tag.split("=");

			// e.g. tag1=value1
			if (segments.length === 2) {
				const [tagName, tagValue] = segments;
				return (tags) => tags[tagName] === tagValue;
			} else { // e.g tag2
				const [tagName] = segments;
				return (tags) => tags[tagName];
			}
		});
	if (hasRequiredTags.length > 0) {
		const logGroupTags = await cloudWatchLogs.getTags(logGroupName);
		const matchedTag = hasRequiredTags.find(f => f(logGroupTags));
		if (!matchedTag) {
			log.debug(`ignored [${logGroupName}] because it doesn't have any of the required tags`, {
				logGroupName,
				tags: process.env.TAGS
			});
			return false;
		}
	}

	return true;
};

const subscribe = async (logGroupName) => {
	try {
		await cloudWatchLogs.putSubscriptionFilter(logGroupName);
	} catch (err) {
		log.error("failed to subscribe log group", { logGroupName }, err);

		// when subscribing a log group to a Lambda function, CloudWatch Logs needs permission
		// to invoke the function
		if (err.code === "InvalidParameterException" &&
        err.message === "Could not execute the lambda function. Make sure you have given CloudWatch Logs permission to execute your function.") {
			log.info(`adding lambda:InvokeFunction permission to CloudWatch Logs for [${DESTINATION_ARN}]`);
			await lambda.addLambdaPermission(DESTINATION_ARN);

			// retry!
			await cloudWatchLogs.putSubscriptionFilter(logGroupName);
		} else {
			throw err;
		}
	}
};
