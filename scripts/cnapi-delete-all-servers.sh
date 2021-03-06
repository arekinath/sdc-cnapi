#!/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2014, Joyent, Inc.
#

set -x xtrace

. /lib/sdc/config.sh
load_sdc_config

sdc-login cnapi svcadm disable cnapi
./tools/deploy-local.sh
sdc-login cnapi /opt/smartdc/cnapi/{build/node/bin/node,node_modules/.bin/delbucket} -h $CONFIG_moray_admin_ips cnapi_servers &
sdc-login cnapi /opt/smartdc/cnapi/{build/node/bin/node,node_modules/.bin/delbucket} -h $CONFIG_moray_admin_ips cnapi_waitlist_tickets &
sdc-login cnapi /opt/smartdc/cnapi/{build/node/bin/node,node_modules/.bin/delbucket} -h $CONFIG_moray_admin_ips cnapi_waitlist_queues &

wait
sdc-login cnapi svcadm enable cnapi
