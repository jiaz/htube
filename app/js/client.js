'use strict';

var EE = require('eventemitter3');
var remote = require('remote');
var app = remote.require('app');

class Socket extends EE {
  constructor() {
    super();
    this.client = null;
    this.seqId = 1;
    this.seqMap = new Map();
  }

  getSeqId() {
    return this.seqId++;
  }

  request(cmd, args, cb) {
    const seqId = this.getSeqId();
    let payload;
    if (typeof args === 'function') {
      payload = {seqId: seqId};
      cb = args;
    } else {
      payload = {args: args, seqId: seqId};
    }
    payload.cmd = cmd;
    this.client.emit('cmd', payload);
    this.seqMap.set(seqId, cb);
  }

  connect() {
    this.client = io('http://localhost.hulu.com:3000', {
      perMessageDeflate: false,
      transports: ['websocket']
    });

    this.client.on('connect', this.onConnect.bind(this));
    this.client.on('auth_required', this.onAuth.bind(this));
    this.client.on('hello', this.onServerHello.bind(this));
    this.client.on('ready', this.onReady.bind(this));
    this.client.on('connect_error', this.onConnectError.bind(this));
  }

  disconnect() {
    this.client.close();
  }

  reconnect() {
    this.disconnect();
    this.connect();
  }

  listUsers(cb) {
    this.request('ls', (err, resp) => {
      console.log(err);
      console.log(resp);
      cb(err, resp);
    });
  }

  onConnect() {
    console.log('connected to server! waiting for server message.');
    this.emit('connected');
  }

  onAuth() {
    console.log('server require you to auth.');
    this.emit('auth_required');
  }

  onServerHello(data) {
    console.log('received server hello message: %s', data.message);
    this.emit('hello', data);
  }

  onConnectError(err) {
    this.client.close();
    console.log('failed to connect to server' + err);
    this.emit('error', err);
  }

  onReady(data) {
    console.log('server callback. seqId: ', data.seqId);
    const cb = this.seqMap.get(data.seqId);
    cb(data.error, data.response);
    this.seqMap.delete(data.seqId);
  }
}

var htubeApp = angular.module('htubeApp', ['ngMaterial', 'ngRoute']);

htubeApp.config(['$routeProvider', '$mdThemingProvider', function ($routeProvider, $mdThemingProvider) {
    $routeProvider
      .when('/', {
        templateUrl: 'templates/login.html',
        controller: 'LoginController'
      })
      .when('/list', {
        templateUrl: 'templates/list.html',
        controller: 'ListUsersController'
      });

    $mdThemingProvider.theme('default');
  }])
  .run(['$rootScope', '$location', '$window', function ($rootScope, $location, $window) {
    $window.location.href = "#";
  }]);

htubeApp.controller('LoginController', ['$scope', '$location', 'socket', ($scope, $location, socket) => {
  $scope.master = {};

  $scope.$on('$viewContentLoaded', function () {
    var loginView = document.getElementById('login');

    loginView.addEventListener("dom-ready", function () {
      // fix font
      loginView.insertCSS('body { overflow:hidden; background-color: white ! important; }');
    });

    loginView.addEventListener("did-get-redirect-request", function (ev) {
      console.log('login view has redirect request.', ev);
      socket.reconnect();
    });

    socket.connect();

    socket.on('auth_required', () => {
      loginView.style.visibility = 'visible';
    });

    socket.on('hello', (data) => {
      socket.session = data.session;
      $location.path('/list');
      $scope.$apply();
    });
  });
}]);

htubeApp.controller('ListUsersController', ['$scope', 'socket', '$mdDialog', function ($scope, socket, $mdDialog) {
  $scope.userProfile = socket.session.userProfile;

  console.log(socket.session.userProfile);

  // list users
  socket.listUsers((err, users) => {
    var userString = JSON.stringify(users[0]);
    users = [];
    for (let i = 0; i < 15; ++i) {
      users.push(JSON.parse(userString));
    }
    console.log('list of users: ' + JSON.stringify(users));
    $scope.onUserUpdated(users);
  });

  $scope.onUserUpdated = function onUserUpdated(users) {
    $scope.users = users;
    $scope.$apply();
  };

  $scope.clickPerson = function clickPerson(user, $event) {
    console.log(user);
    console.log($event);
  };

}]);

htubeApp.factory('socket', function () {
  return new Socket();
});
