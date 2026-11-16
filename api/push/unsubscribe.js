const handler = require("../[...route].js");

module.exports = async function pushUnsubscribe(req, res) {
  return handler(req, res);
};