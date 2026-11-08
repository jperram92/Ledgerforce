/**
 * SS-UC12-02: Mirror fields are read-only for sales users (org part; T-0062, DL-0097).
 *
 * STATUS: written, NOT YET EXECUTED. It needs a scratch org, which needs the Dev Hub the product
 * owner will provide (RQ-0022). The offline half of SS-UC12-02 is proven by
 * salesforce/test/package-contract.test.ts. Run with:
 *   sf apex run test --class-names LFReadOnlyMirrorTest --result-format human --target-org <scratch>
 *
 * Apex DML in tests runs in system mode (no CRUD/FLS), so these saves reach the validation
 * rules: they prove the rules block every user without the LF_Integration_Write custom
 * permission. FLS of the read-only permission set is checked with describe calls as that user.
 */
@IsTest
private class LFReadOnlyMirrorTest {
    private static User newUser(String profileName, String alias) {
        Profile p = [SELECT Id FROM Profile WHERE Name = :profileName LIMIT 1];
        String unique = alias + String.valueOf(Crypto.getRandomInteger()).replace('-', '');
        return new User(
            Alias = alias,
            Email = unique + '@ledgerforce.invalid',
            EmailEncodingKey = 'UTF-8',
            LastName = alias,
            LanguageLocaleKey = 'en_US',
            LocaleSidKey = 'en_AU',
            ProfileId = p.Id,
            TimeZoneSidKey = 'Australia/Sydney',
            Username = unique + '@ledgerforce.invalid'
        );
    }

    private static void assign(User u, String permissionSetName) {
        PermissionSet ps = [SELECT Id FROM PermissionSet WHERE Name = :permissionSetName LIMIT 1];
        insert new PermissionSetAssignment(AssigneeId = u.Id, PermissionSetId = ps.Id);
    }

    private static User salesUser;
    private static User integrationUser;

    private static void setUpUsers() {
        salesUser = newUser('Standard User', 'lfsales');
        integrationUser = newUser('System Administrator', 'lfint');
        System.runAs(new User(Id = UserInfo.getUserId())) {
            insert new List<User>{ salesUser, integrationUser };
            assign(salesUser, 'LF_Read_Only');
            assign(integrationUser, 'LF_Integration_User');
        }
    }

    private static void assertBlocked(SObject record, Boolean isInsert) {
        try {
            if (isInsert) {
                insert record;
            } else {
                update record;
            }
            Assert.fail('the save should have been blocked by an LF validation rule');
        } catch (DmlException e) {
            Assert.areEqual(StatusCode.FIELD_CUSTOM_VALIDATION_EXCEPTION, e.getDmlType(0));
            Assert.isTrue(e.getMessage().contains('maintained by LedgerForce'), e.getMessage());
        }
    }

    @IsTest
    static void salesUserCannotEditBalanceDue() {
        setUpUsers();
        Account a = new Account(Name = 'Acme Pty Ltd');
        System.runAs(salesUser) {
            insert a; // no LF field set: allowed
        }
        System.runAs(integrationUser) {
            update new Account(Id = a.Id, LF_Balance_Due__c = 1375.00);
        }
        System.runAs(salesUser) {
            assertBlocked(new Account(Id = a.Id, LF_Balance_Due__c = 0), false);
            update new Account(Id = a.Id, Name = 'Acme Holdings Pty Ltd'); // other fields still editable
        }
        Assert.areEqual(1375.00, [SELECT LF_Balance_Due__c FROM Account WHERE Id = :a.Id].LF_Balance_Due__c);
    }

    @IsTest
    static void salesUserCannotSetLedgerForceFieldsOnInsert() {
        setUpUsers();
        System.runAs(salesUser) {
            assertBlocked(new Account(Name = 'Beta', LF_Credit_Status__c = 'OK'), true);
            assertBlocked(new Opportunity(Name = 'Deal', StageName = 'Prospecting',
                CloseDate = Date.today(), LF_Amount_Paid__c = 1), true);
        }
    }

    @IsTest
    static void onlyTheIntegrationUserWritesMirrors() {
        setUpUsers();
        LF_Invoice__c inv = new LF_Invoice__c(Name = 'INV-000123',
            LF_Id__c = '7d3c8f5e-1b2a-4c6d-9e8f-0a1b2c3d4e5f', LF_Total__c = 1375.00);
        System.runAs(integrationUser) {
            upsert inv LF_Invoice__c.LF_Id__c;
        }
        System.runAs(salesUser) {
            assertBlocked(new LF_Invoice__c(Id = inv.Id, LF_Amount_Due__c = 0), false);
            assertBlocked(new LF_Payment__c(Name = 'RCT-1', LF_Amount__c = 10), true);
            Assert.isTrue(Schema.SObjectType.LF_Invoice__c.isAccessible());
            Assert.isFalse(Schema.SObjectType.LF_Invoice__c.isUpdateable());
            Assert.isTrue(Schema.SObjectType.Account.fields.LF_Balance_Due__c.isAccessible());
            Assert.isFalse(Schema.SObjectType.Account.fields.LF_Balance_Due__c.isUpdateable());
        }
    }
}
