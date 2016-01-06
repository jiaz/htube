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
    this.client = io('http://10.30.16.85.ip.hulu.com:3000', {
      perMessageDeflate: false,
      transports: ['websocket']
    });

    this.client.on('connect', this.onConnect.bind(this));
    this.client.on('connect_error', this.onConnectError.bind(this));
    this.client.on('ev_auth_required', this.onAuth.bind(this));
    this.client.on('ev_hello', this.onServerHello.bind(this));
    this.client.on('ev_ready', this.onReady.bind(this));
    this.client.on('ev_user_connected', this.onUserConnected.bind(this));
    this.client.on('ev_user_disconnected', this.onUserDisconnected.bind(this));
  }

  disconnect() {
    this.client.close();
  }

  reconnect() {
    this.disconnect();
    this.connect();
  }

  listUsers(cb) {
    this.request('cmd_ls', (err, resp) => {
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

  onUserConnected() {
    console.log('user connected');
    this.emit('user_connected');
  }
  
  onUserDisconnected() {
    console.log('user disconnected');
    this.emit('user_disconnected');
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

  $scope.refreshUser = function refreshUser() {
    console.log('ase')
    socket.listUsers((err, users) => {
      console.log('list of users: ' + JSON.stringify(users));
      $scope.onUserUpdated(users);
    });
  };

  $scope.onUserUpdated = function onUserUpdated(users) {
    $scope.users = users;
    $scope.$apply();
  };

  $scope.clickPerson = function clickPerson(user, $event) {
    console.log(user);
    console.log($event);
  };

  socket.on('user_connected', () => {
    $scope.refreshUser();
  });

  socket.on('user_disconnected', () => {
    $scope.refreshUser();
  })

  $scope.refreshUser();
}]);

htubeApp.factory('socket', function () {
  return new Socket();
});
