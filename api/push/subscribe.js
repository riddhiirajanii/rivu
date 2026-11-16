const handler = require("../[...route].js");

module.exports = async function pushSubscribe(req, res) {
  return handler(req, res);
};