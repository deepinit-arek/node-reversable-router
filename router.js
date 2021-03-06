var Route = require('./route');

exports = module.exports = Router;

/**
 * Initialize a new `Router` with the given `options`.
 *
 * @param {Object} options
 * @api private
 */
function Router(options) {
  var self = this;
  options = options || {};

  this.routesByMethod = [];
  this.routesByMethodAndPath = {};
  this.routesByNameAndMethod = {};
  this.callbacksByPathAndMethod = {};

  this.parameterCallbackWrappers = [];
  this.callbacksPerParameter = {};

  // Alias for `dispatch()` to match the express.js concept
  this.middleware = function router(req, res, next) {
    self.dispatch(req, res, next);
  };

  this.caseSensitive = options.caseSensitive;
}

/**
 * Find matching route
 *
 * @param req
 * @return {boolean|Object}
 */
Router.prototype.match = function (req) {
  var method = req.method.toLowerCase();
  var routes = this.routesByMethod[method];
  if (!routes) return false;
  var offset = req.route == undefined ? 0 : routes.indexOf(req.route) + 1;
  // Performance: Lazy matching. Only match 1 route at a time. Most often the first route will generate the server response
  for (var i = offset; i < routes.length; i++) {
    var route = routes[i];
    var outcome = route.match(req.path);
    if (outcome === false) continue;
    // guarantee array of parameters
    outcome = outcome === true ? [] : outcome;
    return {
      route:    route,
      callbacks:this.callbacksByPathAndMethod[route.path][method],
      params:   outcome
    }
  }
  return false;
}

/**
 * Registers new route
 * @param method
 * @param path
 * @param callbacks
 * @param options
 */
Router.prototype.add = function (method, path, callbacks, options) {
  function flatten(arr, ret) {
    var ret = ret || []
      , len = arr.length;
    for (var i = 0; i < len; ++i) {
      if (Array.isArray(arr[i])) {
        flatten(arr[i], ret);
      } else {
        ret.push(arr[i]);
      }
    }
    return ret;
  }

  callbacks = [callbacks]
  method = method.toLowerCase();

  this.routesByMethodAndPath[method] = this.routesByMethodAndPath[method] || {};
  options.caseSensitive = options.caseSensitive == undefined ? this.caseSensitive : options.caseSensitive;
  if (this.routesByMethodAndPath[method][path] == undefined) {
    var route = new Route(path, options);
    route.__defineGetter__('name', function() {return this.options.name});
    this.routesByMethod[method] = this.routesByMethod[method] || [];
    this.routesByMethod[method].unshift(route);
    this.routesByMethodAndPath[method][path] = route;
    if (options.name != undefined) {
      this.routesByNameAndMethod[options.name] = this.routesByNameAndMethod[options.name] || {};
      this.routesByNameAndMethod[options.name][method] = route;
    }
  } else {
    this.routesByMethodAndPath[method][path].setOptions(options);
  }

  this.callbacksByPathAndMethod[path] = this.callbacksByPathAndMethod[path] || {};
  this.callbacksByPathAndMethod[path][method] = flatten(callbacks);
}

/**
 * Builds a URL based on the route name, method and parameters provided
 *
 * @param name
 * @param params
 * @param method
 * @return {String}
 */
Router.prototype.build = function (name, params, method) {
  if (this.routesByNameAndMethod[name] == undefined) throw new Error('No route found with the name:' + name);
  var possibleRoutes = this.routesByNameAndMethod[name];
  method = method || Object.keys(possibleRoutes)[0];
  return possibleRoutes[method].generate(params);
}

/**
 * Register template helper functions with exress.js application
 * @param app
 * @return Router
 */
Router.prototype.registerAppHelpers = function (app) {
  var self = this;
  var helperName = 'url';
  if (app.helpers) {
    var helpers = {};
    helpers[helperName] = function(name, params, method) { return self.build(name, params, method)};
    app.helpers(helpers);
  } else {
    app.locals[helperName] = function(name, params, method) { return self.build(name, params, method)};
  }
  return this;
}

/**
 * Register a param callback `callback` for the given parameter `name`.
 *
 * @param {String|Function} name
 * @param {Function} callback
 * @return {*|Router} for chaining
 * @api public
 */

Router.prototype.param = function (name, callback) {
  // No name passed, add a modifier
  if ('function' == typeof name) {
    this.parameterCallbackWrappers.push(name);
    return;
  }

  // apply param functions
  var callbackWrappers = this.parameterCallbackWrappers;
  var modifiedCallback;

  callbackWrappers.forEach(function (wrapper) {
    if (modifiedCallback = wrapper(name, callback)) {
      callback = modifiedCallback;
    }
  });

  // ensure we end up with a
  // middleware function
  if (typeof callback != 'function') {
    throw new Error('invalid callback call for `' + name + '`, got ' + callback);
  }

  (this.callbacksPerParameter[name] = this.callbacksPerParameter[name] || []).push(callback);
  return this;
};

/**
 * Chainable routing dispatch
 * (analogous to express middeware concept)
 *
 * @param req
 * @param res
 * @param next
 */
Router.prototype.dispatch = function (req, res, next) {
  var self = this;
  var callbacksPerParameter = this.callbacksPerParameter;

  nextRoute();

  function nextRoute(err) {
    // match route
    var match = self.match(req);
    if (match == false) return next(err);
    req.route = match.route;
    req.params = match.params;

    // workaround vars for the recursion
    var i = 0;
    var paramIndex = 0;
    var paramCallbackIndex;
    var parameterNames = Object.keys(req.params);
    var paramValue;
    var paramName;
    var paramCallbacks;

    //Start the execution chain. Process parameters, next invoke route middleware callbacks
    processNextParameter();

    // Callbacks for each parameter
    // We need this to be recursive rather then a loop in order to allow the fluid `next()` concept from the actual callbacks
    function processNextParameter(err) {
      paramCallbackIndex = 0;
      paramName = parameterNames[paramIndex++];
      paramValue = paramName && req.params[paramName];
      paramCallbacks = paramName && callbacksPerParameter[paramName];

      try {
        if ('route' == err) {
          // Specific case where the error means `next route please`? Strange, anyways this is inherited by express.js
          nextRoute();
        } else if (err) {
          // Handle errors. Assumption is made that there's a global error handler or a specific route callback that handle the errors
          nextRouteMiddleware(err);
        } else if (paramCallbacks) {
          // No errors so just run through the parameter callbacks if there's any
          nextCallbackForParam();
        } else if (paramName) {
          // No callbacks
          processNextParameter();
        } else {
          // Parameter callbacks ended, start running route middleware callbacks
          nextRouteMiddleware();
        }
      } catch (err) {
        processNextParameter(err);
      }
    }

    // single param callbacks
    function nextCallbackForParam(err) {
      var callback = paramCallbacks[paramCallbackIndex++];
      if (err || !callback) return processNextParameter(err);
      callback(req, res, nextCallbackForParam, paramValue, paramName);
    }

    // invoke route callbacks
    function nextRouteMiddleware(err) {
      var callback = match.callbacks[i++];
      try {
        if ('route' == err) {
          // Specific case where the error means `next route please`? Strange.. anyways this is inherited by express.js
          nextRoute();
        } else if (err && callback) {
          // Handle errors. If the current callback doesn't support error handling try next one
          if (callback.length < 4) return nextRouteMiddleware(err);
          callback(err, req, res, nextRouteMiddleware);
        } else if (callback) {
          callback(req, res, nextRouteMiddleware);
        } else {
          // No more callbacks
          nextRoute(err);
        }
      } catch (err) {
        nextRouteMiddleware(err);
      }
    }
  }
};

/**
 * Extend express.js application
 * @param app
 * @return Router
 */
Router.prototype.extendExpress = function (app) {
  var methods = require('methods');
  app._router = this;
  app._routingContext = [];

  methods.forEach(function (method) {
    app[method] = function (key) {
      if ('get' == method && 1 == arguments.length && typeof key == 'string') return this.set(key);
      var args = this._routingContext.concat([].slice.call(arguments));
      // Check if last argument are the route options
      var options = args[args.length - 1];
      if (typeof options != 'function') {
        args.pop();
      } else {
        options = {};
      }

      var path = args.shift();
      // Check if second argument is the route name
      if (typeof args[0] == 'string') {
        options.name = args.shift();
      }
      if (!this._usedRouter) this.use(this.router);
      return this._router.add(method, path, args, options);
    }
  });
  app.route = function (path, name, definitions) {
    this._routingContext = [path, name];
    if (typeof definitions == 'function') {
      definitions();
      this._routingContext = [];
      return;
    }
    for (method in definitions) {
      var args = definitions[method];
      args = Array.isArray(args) ? args : [args];
      app[method].apply(app, args);
    }
    this._routingContext = [];
  }
  return this;
}